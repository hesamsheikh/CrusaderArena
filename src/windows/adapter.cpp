#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <cstdio>
#include <cstring>
#include "inspect_protocol.hpp"
#include "managed_snapshot.hpp"
#include <initializer_list>
#include "ground_snapshot.hpp"
#include <stdexcept>
#include <cmath>
#include <sstream>
#include <string>
namespace {
struct Domain;struct Thread;struct Image;
struct Api {
    Domain* (*root)();Thread* (*attach)(Domain*);void (*detach)(Thread*);
    void (*domains)(void (*)(Domain*,void*),void*);
    const char* (*domain_name)(Domain*);
    void (*assemblies)(void (*)(void*,void*),void*);
    Image* (*image)(void*);const char* (*image_name)(Image*);
    int (*shutting_down)();
    Image* game_image=nullptr;
};
template<class T> bool bind(HMODULE m,T& f,const char* n) {
    auto p=GetProcAddress(m,n);std::memcpy(&f,&p,sizeof(f));return p!=nullptr;
}
void line(crusader::InspectReport& r,const char* kind,const char* name) {
    if(r.used>=sizeof(r.text)-1){r.status=3;return;}
    int n=std::snprintf(r.text+r.used,sizeof(r.text)-r.used,"%s: %.1023s\n",kind,name?name:"<null>");
    if(n>0 && static_cast<unsigned>(n)>=sizeof(r.text)-r.used)r.status=3;
    if(n>0)r.used+=static_cast<std::uint32_t>(n)<sizeof(r.text)-r.used?
        static_cast<std::uint32_t>(n):static_cast<std::uint32_t>(sizeof(r.text)-r.used-1);
}
struct Context {Api* api;crusader::InspectReport* report;};
void domain_callback(Domain* d,void* p) {
    auto& c=*static_cast<Context*>(p);line(*c.report,"domain",c.api->domain_name(d));
}
void assembly_callback(void* a,void* p) {
    auto& c=*static_cast<Context*>(p);auto i=c.api->image(a);
    if(i) {
        const char* name=c.api->image_name(i);
        if(name && std::strcmp(name,"Assembly-CSharp")==0)c.api->game_image=i;
        if(c.report->mode==0)line(*c.report,"assembly",name);
    }
}
#include "live_snapshot.hpp"

void sample(HMODULE runtime,Api& runtime_api,Domain* domain,crusader::InspectReport& report) {
    namespace managed=crusader::managed;
    if(!runtime_api.game_image)throw std::runtime_error("Assembly-CSharp not loaded");
    managed::Class* (*class_from_name)(Image*,const char*,const char*);
    void* (*class_vtable)(Domain*,managed::Class*);
    void (*static_get)(void*,managed::Field*,void*);
    std::uint32_t (*field_flags)(managed::Field*);
    if(!bind(runtime,class_from_name,"mono_class_from_name") ||
       !bind(runtime,class_vtable,"mono_class_vtable") ||
       !bind(runtime,static_get,"mono_field_static_get_value") ||
       !bind(runtime,field_flags,"mono_field_get_flags"))
        throw std::runtime_error("snapshot metadata exports missing");
    managed::Api api(runtime);
    auto singleton=[&](const char* name) {
        auto cls=class_from_name(runtime_api.game_image,"",name);
        if(!cls)throw std::runtime_error("snapshot class missing");
        auto f=api.field_named(cls,"instance");
        if(!f || !(field_flags(f)&0x10) || api.type_kind(api.field_type(f))!=0x12)
            throw std::runtime_error("invalid singleton field");
        auto table=class_vtable(domain,cls);
        if(!table)throw std::runtime_error("class vtable unavailable");
        managed::Object* value=nullptr;static_get(table,f,&value);
        return value;
    };
    managed::Root game(api,singleton("GameData"));
    managed::Root editor(api,singleton("EditorDirector"));
    managed::require_class(api,editor.get(),"EditorDirector");
    auto read_player=[&]() {return managed::field<std::int32_t>(api,editor.get(),"gameLocalPlayerID");};
    auto player=read_player();
    auto first=managed::read_published_snapshot(api,game.get());
    auto second=managed::read_published_snapshot(api,game.get());
    if(first.resources!=second.resources || first.gold!=second.gold ||
       first.tax_index!=second.tax_index || first.game_time!=second.game_time ||
       first.app_mode!=second.app_mode || first.population!=second.population ||
       first.popularity!=second.popularity || first.selected_structure!=second.selected_structure ||
       player!=read_player())throw std::runtime_error("sample changed; no observation returned");
    char json[1024];
    std::snprintf(json,sizeof(json),
        "{\"schema\":1,\"diagnostic_only\":true,\"coherence_verified\":false,"
        "\"gold\":%d,\"wood_planks\":%d,\"tax_index\":%d,\"population\":%d,"
        "\"popularity\":%d,\"app_mode\":%d,\"game_time\":%d,"
        "\"game_local_player_id_candidate\":%d}",
        first.gold,first.wood_planks(),first.tax_index,first.population,
        first.popularity,first.app_mode,first.game_time,player);
    line(report,"sample",json);
    if(report.mode==2) {
        line(report,"notice","Economy diagnostic only; compare with UI. No synchronization or lifecycle guarantee.");
        return;
    }
    // Dictionary metadata is taken from this build's bundled mscorlib. All
    // objects are pinned while inspected; version checks are diagnostic only.
    managed::Object* (*box)(Domain*,managed::Class*,void*);
    managed::Object* (*field_object)(Domain*,managed::Field*,managed::Object*);
    int (*value_size)(managed::Class*,std::uint32_t*);
    if(!bind(runtime,box,"mono_value_box") ||
       !bind(runtime,field_object,"mono_field_get_value_object") ||
       !bind(runtime,value_size,"mono_class_value_size"))
        throw std::runtime_error("character metadata exports missing");
    managed::Root map(api,singleton("GameMap"));
    managed::require_class(api,map.get(),"GameMap");
    managed::Root dictionary(api,managed::field<managed::Object*>(api,map.get(),"chimps"));
    auto dictclass=api.object_class(dictionary.get());
    if(std::strcmp(api.class_name(dictclass),"Dictionary`2") ||
       std::strcmp(api.class_namespace(dictclass),"System.Collections.Generic"))
        throw std::runtime_error("unexpected character dictionary type");
    auto integer=[&](managed::Object* o,const char* n){return managed::field<std::int32_t>(api,o,n);};
    const int version=integer(dictionary.get(),"_version");
    const int count=integer(dictionary.get(),"_count");
    const int free_count=integer(dictionary.get(),"_freeCount");
    if(count<0 || count>65536 || free_count<0 || free_count>count)
        throw std::runtime_error("invalid character dictionary bounds");
    crusader::InspectReport characters;
    characters.status=0;
    unsigned emitted=0;
    if(count) {
        managed::Root entries(api,managed::field<managed::Object*>(api,dictionary.get(),"_entries"));
        auto array=reinterpret_cast<managed::Array*>(entries.get());
        auto cls=api.element_class(api.object_class(entries.get()));
        if(!cls || std::strcmp(api.class_name(cls),"Entry"))
            throw std::runtime_error("unexpected dictionary entry type");
        std::uint32_t alignment=0;int stride=value_size(cls,&alignment);
        if(stride<=0 || stride>256 || api.array_length(array)<static_cast<unsigned>(count))
            throw std::runtime_error("invalid dictionary entry array");
        for(int index=0; index<count && emitted<24; ++index) {
            managed::Root entry(api,box(domain,cls,api.array_address(array,stride,index)));
            if(integer(entry.get(),"hashCode")<0)continue;
            managed::Root chimp(api,managed::field<managed::Object*>(api,entry.get(),"value"));
            managed::require_class(api,chimp.get(),"Chimp");
            auto pf=api.field_named(api.object_class(chimp.get()),"position");
            if(!pf || api.type_kind(api.field_type(pf))!=0x11)
                throw std::runtime_error("invalid render position field");
            managed::Root position(api,field_object(domain,pf,chimp.get()));
            auto pc=api.object_class(position.get());
            if(std::strcmp(api.class_name(pc),"Vector3") || std::strcmp(api.class_namespace(pc),"UnityEngine"))
                throw std::runtime_error("unexpected render position type");
            auto x=managed::field<float>(api,position.get(),"x");
            auto y=managed::field<float>(api,position.get(),"y");
            auto z=managed::field<float>(api,position.get(),"z");
            if(!std::isfinite(x)||!std::isfinite(y)||!std::isfinite(z))
                throw std::runtime_error("nonfinite render position");
            char row[512];
            std::snprintf(row,sizeof(row),
                "{\"id\":%d,\"render_position\":[%.9g,%.9g,%.9g],\"object_type_code\":%d,\"sprite_file\":%d,\"color_code\":%d}",
                integer(entry.get(),"key"),x,y,z,integer(chimp.get(),"gameObjectType"),
                integer(chimp.get(),"file1"),integer(chimp.get(),"colour1"));
            line(characters,"character",row);++emitted;
        }
        if(managed::field<managed::Object*>(api,dictionary.get(),"_entries")!=entries.get())
            throw std::runtime_error("character entries replaced during sample");
    }
    if(version!=integer(dictionary.get(),"_version") || count!=integer(dictionary.get(),"_count") ||
       free_count!=integer(dictionary.get(),"_freeCount") ||
       managed::field<managed::Object*>(api,map.get(),"chimps")!=dictionary.get())
        throw std::runtime_error("character dictionary changed during sample");
    char summary[256];
    std::snprintf(summary,sizeof(summary),
        "{\"tracked_render_characters\":%d,\"returned\":%u,\"limit\":24,\"complete_world_roster\":false,\"coherence_verified\":false}",count-free_count,emitted);
    line(report,"characters",summary);
    if(characters.status || report.used+characters.used>=sizeof(report.text))
        throw std::runtime_error("character report exceeds limit");
    std::memcpy(report.text+report.used,characters.text,characters.used+1);
    report.used+=characters.used;
    // Renderer cache only: inspect bounded samples, never call terrain setters
    // or the native debug-layer export from this unsynchronized worker.
    managed::Root tiles(api,managed::field<managed::Object*>(api,map.get(),"gameMap"));
    int (*class_rank)(managed::Class*);
    if(!bind(runtime,class_rank,"mono_class_get_rank"))
        throw std::runtime_error("array rank export missing");
    auto tc=api.object_class(tiles.get());
    auto te=api.element_class(tc);
    if(class_rank(tc)!=2 || !te || std::strcmp(api.class_name(te),"GameMapTile") ||
       std::strcmp(api.class_namespace(te),""))
        throw std::runtime_error("unexpected map tile array type");
    auto tile_array=reinterpret_cast<managed::Array*>(tiles.get());
    const auto length=api.array_length(tile_array);
    if(!length || length>640000)throw std::runtime_error("invalid map tile array length");
    crusader::InspectReport terrain;
    terrain.status=0;
    managed::Root sprite_loader(api,singleton("spriteLoader"));
    unsigned tile_count=0, inspected=0;
    // Search twelve separate bands so early nonnull border tiles cannot
    // consume the entire sample. At most 4096 slots are examined overall.
    const auto probes=length<4096?length:4096;
    for(std::uintptr_t band=0;band<12;++band) {
      for(std::uintptr_t probe=band*probes/12;probe<(band+1)*probes/12;++probe) {
        const auto index=probe*length/probes;
        managed::Object* raw=nullptr;
        std::memcpy(&raw,api.array_address(tile_array,sizeof(raw),index),sizeof(raw));
        ++inspected;
        if(!raw)continue;
        managed::Root tile(api,raw);
        managed::require_class(api,tile.get(),"GameMapTile");
        const int x=integer(tile.get(),"gameMapX"),y=integer(tile.get(),"gameMapY");
        const int org=integer(tile.get(),"org");
        const float height=managed::field<float>(api,tile.get(),"height");
        if(!std::isfinite(height))throw std::runtime_error("nonfinite map height");
        auto raw_sprite=managed::field<managed::Object*>(api,tile.get(),"tileImage");
        const auto ground=managed::ground_sprite(api,sprite_loader.get(),raw_sprite,class_rank);
        char row[512];
        std::snprintf(row,sizeof(row),
            "{\"game_tile\":[%d,%d],\"render_row\":%d,\"render_column\":%d,\"render_height\":%.9g,\"org_code\":%d,\"ground_sprite_file\":%d,\"ground_sprite_image\":%d,\"ground_sprite_alternate\":%d,\"ground_sprite_matches\":%u}",
            x,y,integer(tile.get(),"row"),integer(tile.get(),"column"),height,org,ground.file,ground.image,ground.alternate,ground.matches);
        managed::Object* again=nullptr;
        std::memcpy(&again,api.array_address(tile_array,sizeof(again),index),sizeof(again));
        if(managed::field<managed::Object*>(api,tile.get(),"tileImage")!=raw_sprite || again!=tile.get() || x!=integer(tile.get(),"gameMapX") ||
           y!=integer(tile.get(),"gameMapY") || org!=integer(tile.get(),"org") ||
           height!=managed::field<float>(api,tile.get(),"height"))
            throw std::runtime_error("map tile changed during sample");
        line(terrain,"map_tile",row);++tile_count;
        break;
      }
    }
    if(managed::field<managed::Object*>(api,map.get(),"gameMap")!=tiles.get())
        throw std::runtime_error("map replaced during sample");
    managed::Root orgs(api,managed::field<managed::Object*>(api,map.get(),"orgs"));
    auto oc=api.object_class(orgs.get());
    if(std::strcmp(api.class_name(oc),"Dictionary`2") ||
       std::strcmp(api.class_namespace(oc),"System.Collections.Generic"))
        throw std::runtime_error("unexpected scenery dictionary type");
    const int ov=integer(orgs.get(),"_version"),on=integer(orgs.get(),"_count");
    const int of=integer(orgs.get(),"_freeCount");
    if(on<0 || on>640000 || of<0 || of>on)
        throw std::runtime_error("invalid scenery dictionary bounds");
    unsigned scenery_count=0;
    if(on) {
        managed::Root entries(api,managed::field<managed::Object*>(api,orgs.get(),"_entries"));
        auto array=reinterpret_cast<managed::Array*>(entries.get());
        auto cls=api.element_class(api.object_class(entries.get()));
        if(!cls || std::strcmp(api.class_name(cls),"Entry"))
            throw std::runtime_error("unexpected scenery entry type");
        std::uint32_t alignment=0;const int stride=value_size(cls,&alignment);
        if(stride<=0 || stride>256 || api.array_length(array)<static_cast<unsigned>(on))
            throw std::runtime_error("invalid scenery entry array");
        for(int i=0;i<on && i<4096 && scenery_count<12;++i) {
            managed::Root entry(api,box(domain,cls,api.array_address(array,stride,i)));
            if(integer(entry.get(),"hashCode")<0)continue;
            managed::Root org(api,managed::field<managed::Object*>(api,entry.get(),"value"));
            managed::require_class(api,org.get(),"Org");
            char row[256];
            std::snprintf(row,sizeof(row),
                "{\"id\":%d,\"render_map\":[%d,%d],\"sprite_file\":%d,\"sprite_image\":%d,\"color_code\":%d}",
                integer(entry.get(),"key"),integer(org.get(),"mapX"),integer(org.get(),"mapY"),
                integer(org.get(),"type"),integer(org.get(),"state"),integer(org.get(),"colour"));
            line(terrain,"scenery",row);++scenery_count;
        }
        if(managed::field<managed::Object*>(api,orgs.get(),"_entries")!=entries.get())
            throw std::runtime_error("scenery entries replaced during sample");
    }
    if(ov!=integer(orgs.get(),"_version") || on!=integer(orgs.get(),"_count") ||
       of!=integer(orgs.get(),"_freeCount") ||
       managed::field<managed::Object*>(api,map.get(),"orgs")!=orgs.get() ||
       singleton("GameMap")!=map.get())
        throw std::runtime_error("map/scenery changed during sample");
    char map_summary[512];
    std::snprintf(map_summary,sizeof(map_summary),
        "{\"array_slots\":%llu,\"slots_inspected\":%u,\"tiles_returned\":%u,"
        "\"tracked_scenery\":%d,\"scenery_returned\":%u,\"complete_map\":false,"
        "\"terrain_labels_verified\":false,\"coherence_verified\":false}",
        static_cast<unsigned long long>(length),inspected,tile_count,on-of,scenery_count);
    line(report,"map",map_summary);
    if(terrain.status || report.used+terrain.used>=sizeof(report.text))
        throw std::runtime_error("map report exceeds limit");
    std::memcpy(report.text+report.used,terrain.text,terrain.used+1);
    report.used+=terrain.used;
    line(report,"notice","Single-player gameplay only; compare with UI. Player ID excludes editor mode. No synchronization or lifecycle guarantee.");
}

}
extern "C" __declspec(dllexport) DWORD WINAPI CrusaderInspect(void* data) {
    auto* r=static_cast<crusader::InspectReport*>(data);
    if(!r||r->magic!=crusader::inspect_magic||r->size!=sizeof(*r)||r->mode>3)return 2;
    r->status=1;r->used=0;r->text[0]=0;
    HMODULE m=GetModuleHandleW(L"mono-2.0-bdwgc.dll");
    Api api{};
    if(!m || !bind(m,api.root,"mono_get_root_domain") ||
       !bind(m,api.attach,"mono_thread_attach") || !bind(m,api.detach,"mono_thread_detach") ||
       !bind(m,api.domains,"mono_domain_foreach") || !bind(m,api.domain_name,"mono_domain_get_friendly_name") ||
       !bind(m,api.assemblies,"mono_assembly_foreach") || !bind(m,api.image,"mono_assembly_get_image") ||
       !bind(m,api.image_name,"mono_image_get_name") || !bind(m,api.shutting_down,"mono_runtime_is_shutting_down")) {
        line(*r,"error","runtime/export missing");return 1;
    }
    if(api.shutting_down()){line(*r,"error","runtime shutting down");r->status=5;return 5;}
    auto root=api.root();
    if(!root){line(*r,"error","runtime not initialized");return 1;}
    auto thread=api.attach(root);
    if(!thread){line(*r,"error","runtime thread attachment failed");return 1;}
    Context c{&api,r};api.domains(domain_callback,&c);api.assemblies(assembly_callback,&c);
    if(r->mode==3) {
        try {
            const auto first=live_snapshot(m,api,root);
            const auto second=live_snapshot(m,api,root);
            if(first!=second)throw std::runtime_error("state changed between reads");
            if(second.size()>=sizeof(r->text))throw std::runtime_error("observation exceeds transport limit");
            std::memcpy(r->text,second.c_str(),second.size()+1);r->used=static_cast<std::uint32_t>(second.size());
        } catch(const std::exception& e) {line(*r,"error",e.what());r->status=4;}
    }
    if(r->mode==1 || r->mode==2) {
        try { sample(m,api,root,*r); }
        catch(const std::exception& e) {line(*r,"error",e.what());r->status=4;}
    }
    api.detach(thread);
    if(r->status==4)return 4;
    if(r->status==3)return 3;
    r->status=0;return 0;
}
BOOL WINAPI DllMain(HINSTANCE,DWORD,LPVOID){return TRUE;}
