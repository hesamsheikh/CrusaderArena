// Default build is read-only. CRUSADER_LAUNCHER enables explicit --inspect only.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <tlhelp32.h>
#include <bcrypt.h>
#include <array>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <vector>
#pragma comment(lib, "bcrypt.lib")

struct Handle {
    HANDLE value;
    explicit Handle(HANDLE v):value(v){}
    ~Handle(){if(value && value!=INVALID_HANDLE_VALUE)CloseHandle(value);}
    Handle(const Handle&)=delete;
};
std::string sha256(const std::filesystem::path& path) {
    std::ifstream f(path,std::ios::binary);
    if(!f)throw std::runtime_error("cannot open module for hashing");
    BCRYPT_ALG_HANDLE alg=nullptr;
    if(BCryptOpenAlgorithmProvider(&alg,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0)
        throw std::runtime_error("SHA-256 provider unavailable");
    struct Cleanup {BCRYPT_ALG_HANDLE a;~Cleanup(){BCryptCloseAlgorithmProvider(a,0);}} cleanup{alg};
    DWORD size=0,got=0;
    if(BCryptGetProperty(alg,BCRYPT_OBJECT_LENGTH,reinterpret_cast<PUCHAR>(&size),sizeof(size),&got,0)<0)
        throw std::runtime_error("SHA-256 object size unavailable");
    std::vector<unsigned char> object(size);
    BCRYPT_HASH_HANDLE hash=nullptr;
    if(BCryptCreateHash(alg,&hash,object.data(),size,nullptr,0,0)<0)
        throw std::runtime_error("SHA-256 initialization failed");
    struct HashCleanup {BCRYPT_HASH_HANDLE h;~HashCleanup(){BCryptDestroyHash(h);}} hc{hash};
    std::array<char,65536> chunk{};
    while(f.read(chunk.data(),chunk.size()) || f.gcount()) {
        if(BCryptHashData(hash,reinterpret_cast<PUCHAR>(chunk.data()),static_cast<ULONG>(f.gcount()),0)<0)
            throw std::runtime_error("SHA-256 update failed");
    }
    if(!f.eof())throw std::runtime_error("module read failed");
    std::array<unsigned char,32> digest{};
    if(BCryptFinishHash(hash,digest.data(),digest.size(),0)<0)
        throw std::runtime_error("SHA-256 finalization failed");
    std::ostringstream s;
    for(auto b:digest)s<<std::hex<<std::setw(2)<<std::setfill('0')<<unsigned(b);
    return s.str();
}
#ifdef CRUSADER_LAUNCHER
#include "launch_inspection.hpp"
#else
#include "native_tile_snapshot.hpp"
#endif
int wmain(int argc,wchar_t** argv) {
    try {
#ifdef CRUSADER_LAUNCHER
        const bool watch=(argc==3||argc==4) && std::wstring(argv[1])==L"--watch";
        unsigned samples=1,interval_ms=500;
        if(watch) {
            std::size_t used=0;const std::wstring value(argv[2]);
            if(value.empty() || value.find_first_not_of(L"0123456789")!=std::wstring::npos)
                throw std::runtime_error("watch count must be 0..1000000; 0 streams until exit");
            const auto n=std::stoul(value,&used);
            if(used!=value.size() || n>1000000)throw std::runtime_error("invalid watch count");
            samples=static_cast<unsigned>(n);
            if(argc==4) {
                const std::wstring ms(argv[3]);
                if(ms.empty() || ms.size()>4 || ms.find_first_not_of(L"0123456789")!=std::wstring::npos ||
                   std::stoul(ms)<50 || std::stoul(ms)>5000)
                    throw std::runtime_error("watch interval must be 50..5000 ms");
                interval_ms=static_cast<unsigned>(std::stoul(ms));
            }
        } else if(argc!=2||(std::wstring(argv[1])!=L"--inspect" && std::wstring(argv[1])!=L"--sample" && std::wstring(argv[1])!=L"--economy"))
            throw std::runtime_error("usage: crusader_launcher --inspect | --sample | --economy | --watch count [interval_ms] (loads our DLL)");
#else
        const bool tile_mode=argc==4 && wcscmp(argv[1],L"--tile")==0;
        const bool block_mode=argc==4 && wcscmp(argv[1],L"--tile-block")==0;
        const bool town_mode=argc==2 && wcscmp(argv[1],L"--town-map")==0;
        const bool region_mode=argc==6 && wcscmp(argv[1],L"--tile-region")==0;
        const bool map_mode=argc==2 && wcscmp(argv[1],L"--map-summary")==0;
        const bool structure_mode=argc==4 && wcscmp(argv[1],L"--structure-bytes")==0;
        if(argc!=1 && !tile_mode && !block_mode && !town_mode && !region_mode && !map_mode && !structure_mode)
            throw std::runtime_error("usage: crusader_probe [--tile x y | --tile-block x y | --town-map | --tile-region x0 y0 w h | --map-summary]");
        int region[4]={0,0,0,0};
        if(region_mode)
            for(int i=0;i<4;++i) {
                std::size_t used=0;const std::wstring text(argv[2+i]);
                region[i]=std::stoi(text,&used);
                if(used!=text.size() || region[i]<=0 || region[i]>=800)throw std::runtime_error("invalid tile region argument");
            }
        int tile_x=0,tile_y=0;
        if(tile_mode || block_mode) {
            const auto coordinate=[](const wchar_t* s) {
                std::size_t used=0;const std::wstring text(s);
                const int value=std::stoi(text,&used);
                if(used!=text.size() || value<=0 || value>=800)throw std::runtime_error("invalid tile coordinate");
                return value;
            };
            tile_x=coordinate(argv[2]);tile_y=coordinate(argv[3]);
            if(block_mode && (tile_x%5 || tile_y%5 || tile_x>795 || tile_y>795))
                throw std::runtime_error("tile-block requires a 5-aligned origin in 5..795");
        }
#endif
        static_assert(sizeof(void*)==8,"Build this probe for Windows x64");
        Handle processes(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0));
        if(processes.value==INVALID_HANDLE_VALUE)throw std::runtime_error("cannot enumerate processes");
        PROCESSENTRY32W entry{};entry.dwSize=sizeof(entry);
        std::vector<DWORD> matches;
        if(!Process32FirstW(processes.value,&entry))throw std::runtime_error("cannot read process list");
        do {
            if(_wcsicmp(entry.szExeFile,L"Stronghold Crusader Definitive Edition.exe")==0)
                matches.push_back(entry.th32ProcessID);
        } while(Process32NextW(processes.value,&entry));
        if(matches.size()!=1)throw std::runtime_error("expected exactly one running game; start it through Steam");
        Handle modules(CreateToolhelp32Snapshot(TH32CS_SNAPMODULE|TH32CS_SNAPMODULE32,matches[0]));
        if(modules.value==INVALID_HANDLE_VALUE)throw std::runtime_error("cannot enumerate game modules; retry after loading");
        MODULEENTRY32W m{};m.dwSize=sizeof(m);
        std::filesystem::path exe,engine,mono;
        std::uintptr_t engine_base=0;DWORD engine_size=0;
        if(!Module32FirstW(modules.value,&m))throw std::runtime_error("cannot read game modules");
        do {
            if(_wcsicmp(m.szModule,L"CrusaderDE.dll")==0) {
                engine=m.szExePath;engine_base=reinterpret_cast<std::uintptr_t>(m.modBaseAddr);engine_size=m.modBaseSize;
            }
            if(_wcsicmp(m.szModule,L"mono-2.0-bdwgc.dll")==0)mono=m.szExePath;
            if(_wcsicmp(m.szModule,L"Stronghold Crusader Definitive Edition.exe")==0)exe=m.szExePath;
        } while(Module32NextW(modules.value,&m));
        if(exe.empty()||engine.empty()||mono.empty())throw std::runtime_error("game/engine/Mono module missing; wait until the game loads");
        const auto managed=exe.parent_path()/L"Stronghold Crusader Definitive Edition_Data"/L"Managed"/L"Assembly-CSharp.dll";
        struct Check {std::filesystem::path path;const char* expected;};
        const Check checks[]={
            {mono,"6ef9f938fe54c1d4ed6958f892596a39721b488d4ebed1a54f1644ecb230216f"},
            {exe,"8acea6d11af81cf26b035a479ba633bdb0d09513742055f3f46330d72b2f203a"},
            {engine,"fbcb93195fc7efca9bdac5204852efdd76f9818f59a6711750d77c9cef2831e2"},
            {managed,"bc8b6a395f01d48557db413600c8dd8d1fdfd3abdf97bfbbb68a3c56b04fd789"}
        };
        bool supported=true;
        std::cout<<"PID "<<matches[0]<<"\n";
        for(const auto& c:checks) {
            const auto actual=sha256(c.path);
            const bool match=actual==c.expected;supported&=match;
            std::wcout<<c.path.filename().wstring()<<L"\n";
            std::cout<<actual<<" "<<(match?"MATCH":"MISMATCH")<<"\n";
        }
        if(!supported)throw std::runtime_error("unsupported game files; no integration may use the mapped layouts");
        std::cout<<"File fingerprints match the analyzed copy. The fingerprint check itself does not read live state.\n";
#ifdef CRUSADER_LAUNCHER
        crusader::inspect_in_game(matches[0],exe,watch?3u:(std::wstring(argv[1])==L"--economy"?2u:(std::wstring(argv[1])==L"--sample"?1u:0u)),samples,interval_ms);
#else
        if(tile_mode)crusader::sample_native_tile(matches[0],engine_base,engine_size,tile_x,tile_y);
        if(block_mode) {
            for(int x=tile_x;x<tile_x+5;++x)
                for(int y=tile_y;y<tile_y+5;++y)
                    crusader::sample_native_tile(matches[0],engine_base,engine_size,x,y);
            std::cout<<"Native block diagnostic finished. Records are sampled separately, not atomically.\n";
        }
        if(town_mode)crusader::sample_native_towns(matches[0],engine_base,engine_size);
        if(map_mode)crusader::sample_native_map(matches[0],engine_base,engine_size);
        if(region_mode)crusader::sample_native_region(matches[0],engine_base,engine_size,region[0],region[1],region[2],region[3]);
        if(structure_mode)crusader::sample_native_structure_bytes(matches[0],engine_base,engine_size,std::stoi(std::wstring(argv[2])),std::stoi(std::wstring(argv[3])));
#endif
        return 0;
    } catch(const std::exception& e) {
        std::cerr<<"Probe failed: "<<e.what()<<"\n";return 1;
    }
}
