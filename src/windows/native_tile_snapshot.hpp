#pragma once
#include <algorithm>
#include <cstdint>
#include <cstring>

// Read-only external diagnostic for the hash checked by probe.cpp. These
// addresses are derived from DLL_GetLayerDebug, not from the original game.
namespace crusader {
void read_native_bytes(HANDLE process, std::uintptr_t base, DWORD size,
                       std::uint64_t rva, void* output, std::size_t bytes) {
    if(rva>size || bytes>size-rva)
        throw std::runtime_error("native layer address outside engine module");
    SIZE_T copied=0;
    if(!ReadProcessMemory(process,reinterpret_cast<const void*>(base+rva),output,bytes,&copied)
       || copied!=bytes)throw std::runtime_error("native layer memory unavailable");
}
template<class T>
T read_native(HANDLE process, std::uintptr_t base, DWORD size, std::uint64_t rva) {
    T value{};
    read_native_bytes(process,base,size,rva,&value,sizeof(value));
    return value;
}

void sample_native_towns(DWORD pid,std::uintptr_t base,DWORD size) {
    Handle process(OpenProcess(PROCESS_VM_READ|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid));
    if(!process.value)throw std::runtime_error("cannot open game for read-only town diagnostic");
    constexpr std::size_t count=160*160,stride=48;
    std::vector<std::int8_t> first(count*stride),second(count*stride);
    read_native_bytes(process.value,base,size,0x35057a0,first.data(),first.size());
    read_native_bytes(process.value,base,size,0x35057a0,second.data(),second.size());
    if(first!=second)throw std::runtime_error("town grid changed; retry while paused");
    DWORD exit_code=0;
    if(!GetExitCodeProcess(process.value,&exit_code)||exit_code!=STILL_ACTIVE)
        throw std::runtime_error("game exited during town diagnostic");
    std::size_t returned=0;
    for(std::size_t index=0;index<count;++index) {
        const auto at=[&](std::size_t offset){return int(first[index*stride+offset]);};
        if(!(at(8)||at(17)||at(18)||at(9)))continue;
        ++returned;
        std::cout<<"native_town: {\"tile_origin\":["<<(index/160)*5<<","<<(index%160)*5
                 <<"],\"tile_extent\":[5,5],\"town_stone_value\":"<<at(8)
                 <<",\"town_oasis\":"<<at(17)<<",\"town_farm\":"<<at(18)
                 <<",\"town_iron\":"<<at(9)<<"}\n";
    }
    std::cout<<"native_towns: {\"grid_records\":"<<count<<",\"returned_nonzero\":"<<returned
             <<",\"diagnostic_only\":true,\"coherence_verified\":false,\"terrain_semantics_verified\":false,"
               "\"playable_bounds_verified\":false}\n";
    std::cout<<"Native town diagnostic finished. Omitted records have zero in these four fields; this does not prove no resources. No game functions called.\n";
}

// A rectangle of tiles in one pass: tiles of one row are contiguous in every layer
// (index = x + row[y]), so each row costs one read per layer. Two full reads must
// agree for the structure/organism/logic2 layers (units move, so occupancy and
// walk may differ). Output is one JSON line with row-major (y outer) arrays.
void sample_native_region(DWORD pid, std::uintptr_t base, DWORD size, int x0, int y0, int w, int h) {
    if(x0<=0 || y0<=0 || w<=0 || h<=0 || w>160 || h>160 || x0+w>800 || y0+h>800)
        throw std::runtime_error("tile region must lie in 1..799 and be at most 160x160");
    Handle process(OpenProcess(PROCESS_VM_READ|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid));
    if(!process.value)throw std::runtime_error("cannot open game for read-only tile region");
    struct Layer {const char* name;std::uint64_t rva;int bytes;bool is_signed;bool stable;};
    const Layer layers[]={
        {"structure",0x4b6aa50,2,true,true},{"organism",0x4ace010,2,true,true},
        {"logic",0x48f71b0,4,true,false},{"logic2",0x4a312b0,1,true,true},
        {"height",0x4ddd350,1,false,false},{"occupancy",0x51d75f0,1,true,false},
        {"walk",0x52c2550,2,true,false},{"gfx",0x419f6b0,4,true,false},
    };
    constexpr std::size_t n_layers=sizeof(layers)/sizeof(layers[0]);
    const auto capture=[&]() {
        std::vector<std::vector<std::int64_t>> out(n_layers,std::vector<std::int64_t>(std::size_t(w)*h));
        std::vector<std::uint8_t> row_bytes(std::size_t(w)*4);
        for(int dy=0;dy<h;++dy) {
            const auto row=read_native<std::int32_t>(process.value,base,size,0x402ff2cull+12ull*(y0+dy));
            const auto first=std::int64_t(row)+x0;
            if(first<0 || first+w>320800)throw std::runtime_error("native tile row outside layer capacity");
            for(std::size_t l=0;l<n_layers;++l) {
                const auto& L=layers[l];
                read_native_bytes(process.value,base,size,L.rva+std::uint64_t(first)*L.bytes,row_bytes.data(),std::size_t(w)*L.bytes);
                for(int dx=0;dx<w;++dx) {
                    const auto* p=row_bytes.data()+std::size_t(dx)*L.bytes;
                    std::int64_t v=0;
                    if(L.bytes==1)v=L.is_signed?std::int64_t(std::int8_t(p[0])):std::int64_t(p[0]);
                    else if(L.bytes==2){std::int16_t t;std::memcpy(&t,p,2);v=t;}
                    else {std::int32_t t;std::memcpy(&t,p,4);v=t;}
                    out[l][std::size_t(dy)*w+dx]=v;
                }
            }
        }
        return out;
    };
    const auto first=capture(),second=capture();
    bool stable=true;
    for(std::size_t l=0;l<n_layers;++l)if(layers[l].stable && first[l]!=second[l])stable=false;
    DWORD exit_code=0;
    if(!GetExitCodeProcess(process.value,&exit_code)||exit_code!=STILL_ACTIVE)
        throw std::runtime_error("game exited during tile region");
    std::ostringstream out;
    out<<"{\"x0\":"<<x0<<",\"y0\":"<<y0<<",\"w\":"<<w<<",\"h\":"<<h<<",\"stable\":"<<(stable?"true":"false")<<",\"layers\":{";
    for(std::size_t l=0;l<n_layers;++l) {
        out<<(l?",":"")<<'"'<<layers[l].name<<"\":[";
        for(std::size_t i=0;i<second[l].size();++i)out<<(i?",":"")<<second[l][i];
        out<<']';
    }
    out<<"}";
    // Building type per instance id in the region (i16 at 0x64cccde + id*0x32c; 0x34 is the
    // signpost) and the signpost no-build radius global the game's placement check adds 4 to.
    std::vector<std::int64_t> ids;
    for(const auto v:second[0])if(v>0 && std::find(ids.begin(),ids.end(),v)==ids.end())ids.push_back(v);
    out<<",\"structure_types\":{";
    for(std::size_t i=0;i<ids.size();++i)
        out<<(i?",":"")<<'"'<<ids[i]<<"\":"<<read_native<std::int16_t>(process.value,base,size,0x64cccdeull+std::uint64_t(ids[i])*0x32cull);
    out<<"},\"signpost_radius\":"<<read_native<std::int32_t>(process.value,base,size,0x37ef8f8)<<"}";
    std::cout<<"tile_region: "<<out.str()<<"\n";
    std::cout<<"Native tile region finished. Raw layer values; semantics are being validated. No game functions called.\n";
}

// The whole map, one category letter per tile, run-length encoded per row (letter then
// count). Categories follow harness/server/map-view.ts; the playable-area mask comes from
// the game's placement checker.
void sample_native_map(DWORD pid, std::uintptr_t base, DWORD size) {
    Handle process(OpenProcess(PROCESS_VM_READ|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid));
    if(!process.value)throw std::runtime_error("cannot open game for read-only map summary");
    constexpr int N=800;constexpr std::int64_t capacity=320800;
    std::vector<std::uint8_t> mask(std::size_t(N)*N);
    read_native_bytes(process.value,base,size,0x3a11ea4,mask.data(),mask.size());
    std::vector<std::int16_t> structure(N),organism(N),occupancy_row(N);
    std::vector<std::int32_t> logic(N);std::vector<std::int8_t> ground(N),occupancy(N);
    const auto read_row=[&](std::uint64_t rva,int bytes,std::int64_t first,void* out) {
        std::memset(out,0,std::size_t(N)*bytes);
        std::int64_t lo=std::max<std::int64_t>(first,0),hi=std::min<std::int64_t>(first+N,capacity);
        if(hi<=lo)return;
        read_native_bytes(process.value,base,size,rva+std::uint64_t(lo)*bytes,
                          static_cast<std::uint8_t*>(out)+(lo-first)*bytes,std::size_t(hi-lo)*bytes);
    };
    std::ostringstream out;
    int x0=N,y0=N,x1=-1,y1=-1;
    out<<"{\"size\":"<<N<<",\"rows\":[";
    for(int y=0;y<N;++y) {
        const auto row=read_native<std::int32_t>(process.value,base,size,0x402ff2cull+12ull*y);
        const std::int64_t first=std::int64_t(row);
        read_row(0x4b6aa50,2,first,structure.data());read_row(0x4ace010,2,first,organism.data());
        read_row(0x48f71b0,4,first,logic.data());read_row(0x4a312b0,1,first,ground.data());
        read_row(0x51d75f0,1,first,occupancy.data());
        std::string letters(N,'_');
        for(int x=0;x<N;++x) {
            if(!mask[std::size_t(y)*N+x])continue;
            x0=std::min(x0,x);y0=std::min(y0,y);x1=std::max(x1,x);y1=std::max(y1,y);
            const std::uint32_t L=std::uint32_t(logic[x]);const int g=ground[x];
            char c;
            if(L&0x10000000)c='K';
            else if(structure[x])c='B';
            else if(L&0x4)c='F';
            else if((L&0x100000) || L==0x1)c='W';
            else if(L&0x30)c='M';
            else if(organism[x] && (L&0x1000))c='T';
            else if(organism[x] || (L&0x80))c='R';
            else if(occupancy[x]<0)c='a';
            else if(L&0x80000)c='I';
            else if(L&0x20000)c='S';
            else if(L&0x80000000u)c='P';
            else if(L&0x20000000)c='m';
            else if((L&0x8000) && !(L&~0xa000u)) c=(g==16||g==-128)?'O':g==1?'s':'.';
            else if(L==0)c='h';
            else c='x';
            letters[x]=c;
        }
        out<<(y?",":"")<<'"';
        for(int x=0;x<N;) {int e=x;while(e<N && letters[e]==letters[x])++e;out<<letters[x]<<(e-x);x=e;}
        out<<'"';
    }
    out<<"],\"bounds\":{\"x0\":"<<x0<<",\"y0\":"<<y0<<",\"x1\":"<<x1<<",\"y1\":"<<y1<<"}}";
    DWORD exit_code=0;
    if(!GetExitCodeProcess(process.value,&exit_code)||exit_code!=STILL_ACTIVE)
        throw std::runtime_error("game exited during map summary");
    std::cout<<"map_summary: "<<out.str()<<"\n";
    std::cout<<"Native map summary finished. One read per row per layer, not atomic. No game functions called.\n";
}

void sample_native_tile(DWORD pid, std::uintptr_t base, DWORD size, int x, int y) {
    if(x<=0 || x>=800 || y<=0 || y>=800)
        throw std::runtime_error("diagnostic coordinates must be in 1..799; validity remains unverified");
    Handle process(OpenProcess(PROCESS_VM_READ|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid));
    if(!process.value)throw std::runtime_error("cannot open game for read-only tile diagnostic");
    const auto read=[&]<class T>(std::uint64_t rva){return read_native<T>(process.value,base,size,rva);};
    const auto row=read.operator()<std::int32_t>(0x402ff2cull+12ull*y);
    const auto index=std::int64_t(row)+x;
    // Adjacent four-byte arrays in the export are 0x139480 apart.
    // A stricter bound than the full 800x800 square avoids reading a neighbor.
    if(index<0 || index>=320800)throw std::runtime_error("native compressed tile index outside layer capacity");
    const auto capture=[&]() {
        std::ostringstream out;
        out<<"{\"game_tile\":["<<x<<","<<y<<"],\"native_index\":"<<index;
        const auto field=[&]<class T>(const char* name,std::uint64_t rva) {
            out<<",\""<<name<<"\":"<<std::int64_t(read.operator()<T>(rva+index*sizeof(T)));
        };
        field.operator()<std::int32_t>("gfx_layer",0x419f6b0);
        field.operator()<std::int32_t>("logic_layer",0x48f71b0);
        field.operator()<std::int8_t>("logic2_layer",0x4a312b0);
        field.operator()<std::int16_t>("organism_layer",0x4ace010);
        field.operator()<std::int16_t>("structure_layer",0x4b6aa50);
        field.operator()<std::uint8_t>("height_layer",0x4ddd350);
        field.operator()<std::uint8_t>("wall_owner_layer",0x4e79d90);
        field.operator()<std::int8_t>("occupancy_layer",0x51d75f0);
        field.operator()<std::int16_t>("walk_layer",0x52c2550);
        const auto town=0x35057a0ull+48ull*((x/5)*160+y/5);
        out<<",\"town_stone_value\":"<<int(read.operator()<std::int8_t>(town+8))
           <<",\"town_oasis\":"<<int(read.operator()<std::int8_t>(town+17))
           <<",\"town_farm\":"<<int(read.operator()<std::int8_t>(town+18))
           <<",\"town_iron\":"<<int(read.operator()<std::int8_t>(town+9))
           <<",\"diagnostic_only\":true,\"coherence_verified\":false,\"terrain_semantics_verified\":false}";
        return out.str();
    };
    const auto first=capture(),second=capture();
    if(first!=second || row!=read.operator()<std::int32_t>(0x402ff2cull+12ull*y))
        throw std::runtime_error("native layers changed during diagnostic; retry while paused");
    DWORD exit_code=0;
    if(!GetExitCodeProcess(process.value,&exit_code)||exit_code!=STILL_ACTIVE)
        throw std::runtime_error("game exited during diagnostic");
    std::cout<<"native_tile: "<<first<<"\n";
    std::cout<<"Native tile diagnostic finished. Two equal reads do not prove synchronization. No game functions called.\n";
}
}
