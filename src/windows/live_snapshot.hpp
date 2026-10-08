#pragma once
#include <cmath>
#include <sstream>
#include <string>

// Included inside adapter's anonymous namespace, after its Mono API definitions.
struct LiveAccess {
    crusader::managed::Api api;
    Domain* domain; Image* image;
    crusader::managed::Class* (*find_class)(Image*,const char*,const char*);
    void* (*vtable)(Domain*,crusader::managed::Class*);
    void (*static_get)(void*,crusader::managed::Field*,void*);
    std::uint32_t (*flags)(crusader::managed::Field*);
    int (*string_length)(crusader::managed::Object*);
    const std::uint16_t* (*string_chars)(crusader::managed::Object*);
    // Optional managed-heap totals for memory diagnostics; null when not exported.
    std::int64_t (*gc_heap_size)()=nullptr;
    std::int64_t (*gc_used_size)()=nullptr;
    int (*gc_collections)(int)=nullptr;
    int (*gc_pending_finalizers)()=nullptr;
    LiveAccess(HMODULE runtime,Domain* d,Image* i):api(runtime),domain(d),image(i) {
        if(!i || !bind(runtime,find_class,"mono_class_from_name") ||
           !bind(runtime,vtable,"mono_class_vtable") ||
           !bind(runtime,static_get,"mono_field_static_get_value") ||
           !bind(runtime,flags,"mono_field_get_flags") ||
           !bind(runtime,string_length,"mono_string_length") ||
           !bind(runtime,string_chars,"mono_string_chars"))
            throw std::runtime_error("live metadata exports unavailable");
        if(!bind(runtime,gc_heap_size,"mono_gc_get_heap_size") || !bind(runtime,gc_used_size,"mono_gc_get_used_size"))
            gc_heap_size=nullptr,gc_used_size=nullptr;
        if(!bind(runtime,gc_collections,"mono_gc_collection_count") ||
           !bind(runtime,gc_pending_finalizers,"mono_gc_pending_finalizers"))
            gc_collections=nullptr,gc_pending_finalizers=nullptr;
    }
    crusader::managed::Class* cls(const char* name,const char* ns="") {
        auto c=find_class(image,ns,name);
        if(!c)throw std::runtime_error("live class missing");
        return c;
    }
    template<class T> T stat(crusader::managed::Class* c,const char* name,int kind) {
        auto f=api.field_named(c,name);
        if(!f || !(flags(f)&0x10) || api.type_kind(api.field_type(f))!=kind)
            throw std::runtime_error(std::string("static field metadata mismatch: ")+name);
        auto table=vtable(domain,c);if(!table)throw std::runtime_error("vtable missing");
        T value{};static_get(table,f,&value);return value;
    }
    crusader::managed::Object* singleton(const char* name,const char* ns="") {
        return stat<crusader::managed::Object*>(cls(name,ns),"instance",0x12);
    }
    std::string string_json(crusader::managed::Object* obj,bool trim_spaces=false) {
        if(!obj)return "null";
        crusader::managed::Root root(api,obj);
        auto c=api.object_class(root.get());
        if(std::strcmp(api.class_name(c),"String") || std::strcmp(api.class_namespace(c),"System"))
            throw std::runtime_error("expected String");
        int n=string_length(root.get());
        if(n<0 || n>2048)throw std::runtime_error("string exceeds observation limit");
        auto chars=string_chars(root.get());std::string out="\"";
        int first=0;
        if(trim_spaces) {
            while(first<n && chars[first]==' ')++first;
            while(n>first && chars[n-1]==' ')--n;
        }
        for(int j=first;j<n;++j) {
            char encoded[7];std::snprintf(encoded,sizeof(encoded),"\\u%04x",unsigned(chars[j]));out+=encoded;
        }
        return out+'"';
    }
};

std::string live_snapshot(HMODULE runtime,Api& runtime_api,Domain* domain) {
    namespace m=crusader::managed;
    LiveAccess a(runtime,domain,runtime_api.game_image);
    m::Root game(a.api,a.singleton("GameData"));
    m::Root editor(a.api,a.singleton("EditorDirector"));
    m::Root director(a.api,a.singleton("Director"));
    m::Root view(a.api,a.singleton("MainViewModel","CrusaderDE"));
    const auto player=m::field<std::int32_t>(a.api,editor.get(),"gameLocalPlayerID");
    const auto mode=m::field<std::int32_t>(a.api,game.get(),"_app_mode");
    if((mode!=14 && mode!=16) || player<1 || player>8 ||
       !m::field<bool>(a.api,director.get(),"engineRunning") ||
       m::field<bool>(a.api,director.get(),"multiplayerGame") ||
       m::field<bool>(a.api,view.get(),"IsMapEditorMode"))
        throw std::runtime_error("not an active local single-player map: mode="+std::to_string(mode)+" player="+std::to_string(player)+" multiplayerGame="+std::to_string(m::field<bool>(a.api,director.get(),"multiplayerGame"))+" editor="+std::to_string(m::field<bool>(a.api,view.get(),"IsMapEditorMode")));
    m::Root state(a.api,m::field<m::Object*>(a.api,game.get(),"_lastGameState"));
    m::Root map(a.api,a.singleton("GameMap"));
    // The backing map allocation changes on loads, unlike the persistent singleton.
    m::Root map_data(a.api,m::field<m::Object*>(a.api,map.get(),"gameMap"));
    if(m::field<std::uint8_t>(a.api,state.get(),"spectatorMode"))
        throw std::runtime_error("spectator state excluded");
    auto economy=m::read_published_snapshot(a.api,game.get());
    if(economy.app_mode!=mode)throw std::runtime_error("mode changed during capture");
    m::Root troops(a.api,m::field<m::Object*>(a.api,state.get(),"troop_counts"));
    auto element=a.api.element_class(a.api.object_class(troops.get()));
    auto array=reinterpret_cast<m::Array*>(troops.get());
    if(!element || std::strcmp(a.api.class_name(element),"Int16") ||
       std::strcmp(a.api.class_namespace(element),"System") || a.api.array_length(array)!=34)
        throw std::runtime_error("troop array metadata mismatch");
    std::ostringstream counts;int total=0;
    for(int i=0;i<34;++i) {
        std::int16_t n;std::memcpy(&n,a.api.array_address(array,2,i),2);
        if(n<0)throw std::runtime_error("negative troop count");
        if(i)counts<<',';counts<<n;total+=n;
    }
    // Placement/camera context. Optional: an unavailable singleton reports null
    // instead of withholding the validated economy fields.
    const auto optional=[](auto read)->std::string {
        try{return read();}catch(const std::runtime_error&){return "null";}
    };
    // Engine object-pool counter (map-editor "objects left"); likely map-wide, not own buildings.
    const std::string structures="{\"count\":"+std::to_string(m::field<std::int16_t>(a.api,state.get(),"structs_count"))+
        ",\"limit\":"+std::to_string(m::field<std::int16_t>(a.api,state.get(),"structs_limit"))+"}";
    const auto placement=optional([&]()->std::string {
        m::Root controls(a.api,a.singleton("MainControls"));
        return "{\"action\":"+std::to_string(m::field<std::int32_t>(a.api,controls.get(),"currentAction"))+
            ",\"sub_action\":"+std::to_string(m::field<std::int32_t>(a.api,controls.get(),"currentSubAction"))+"}";
    });
    const auto camera=optional([&]()->std::string {
        m::Root zoom(a.api,a.singleton("PerfectPixelWithZoom"));
        const auto scale=m::field<float>(a.api,zoom.get(),"pixelsPerUnitScale");
        if(!std::isfinite(scale))throw std::runtime_error("non-finite zoom scale");
        std::ostringstream c;
        c<<"{\"centre_tile_x\":"<<m::field<std::int32_t>(a.api,map.get(),"screenCentreTileX")
         <<",\"centre_tile_y\":"<<m::field<std::int32_t>(a.api,map.get(),"screenCentreTileY")
         <<",\"tiles_wide\":"<<m::field<std::int32_t>(a.api,map.get(),"screenTilesWide")
         <<",\"tiles_high\":"<<m::field<std::int32_t>(a.api,map.get(),"screenTilesHigh")
         <<",\"pixels_per_unit_scale\":"<<scale<<'}';
        return c.str();
    });
    // Settlement context from the same PlayState (calendar, housing, food, popularity
    // factors). Optional; field meanings beyond the names need UI validation.
    const auto i32=[&](const char* name){return m::field<std::int32_t>(a.api,state.get(),name);};
    const auto i16=[&](const char* name){return m::field<std::int16_t>(a.api,state.get(),name);};
    const auto settlement=optional([&]()->std::string {
        std::ostringstream s;
        s<<"{\"month\":"<<i16("month")<<",\"year\":"<<i16("year")
         <<",\"housing_cap\":"<<i32("housing_cap")
         <<",\"peasants_available\":"<<i16("peasants_available_for_troops")
         <<",\"total_food\":"<<i32("total_food")<<",\"months_of_food\":"<<i32("months_of_food")
         <<",\"rationing\":"<<i32("rationing")<<",\"food_types_eaten\":"<<i32("food_types_eaten")
         <<",\"food_types_available\":"<<i32("food_types_available")
         <<",\"efficiency\":"<<i32("efficiency")<<",\"upcoming_popularity\":"<<i32("upcoming_total_popularity")
         <<",\"popularity_factors\":{";
        const char* factors[][2]={{"food","food_popularity"},{"food_variety","foodsEaten_popularity"},
            {"rationing","rationing_popularity"},{"tax","tax_popularity"},{"overcrowding","overcrowding_popularity"},
            {"fear_factor","fearFactor_popularity"},{"religion","religion_popularity"},{"fairs","fairs_popularity"},
            {"plague","plague_popularity"},{"wolves","wolves_popularity"},{"bandits","bandits_popularity"},
            {"fire","fire_popularity"},{"marriage","marriage_popularity"},{"jester","jester_popularity"}};
        bool first=true;
        for(const auto& f:factors){s<<(first?"":",")<<'"'<<f[0]<<"\":"<<i32(f[1]);first=false;}
        s<<",\"inn\":"<<i16("inn_coverage_popularity")<<"}}";
        return s.str();
    });
    // The building whose panel is open (PlayState copies it every tick); null when none.
    const auto selected_building=optional([&]()->std::string {
        const auto id=i32("in_structure");
        if(id<=0)return "null";
        std::ostringstream s;
        s<<"{\"id\":"<<id<<",\"type\":"<<i32("in_structure_type")
         <<",\"have_stats\":"<<i16("have_building_stats")<<",\"workers_have\":"<<i16("workers_have")
         <<",\"job_vacancies\":"<<i16("job_vacancies")<<",\"workers_needed\":"<<i16("workers_needed")
         <<",\"working\":"<<i16("working")<<",\"turned_off\":"<<i16("turned_off")
         <<",\"keep_access\":"<<i16("got_keep_access")<<",\"hp\":"<<i16("building_hps_for_repair")
         <<",\"max_hp\":"<<i16("building_maxhps_for_repair")
         <<",\"no_resources\":"<<int(m::field<std::uint8_t>(a.api,state.get(),"production_no_resources"))<<'}';
        return s.str();
    });
    const std::string managed_heap=a.gc_heap_size
        ? "{\"heap_bytes\":"+std::to_string(a.gc_heap_size())+",\"used_bytes\":"+std::to_string(a.gc_used_size())+
          (a.gc_collections ? ",\"collections\":"+std::to_string(a.gc_collections(0))+
             ",\"finalizers_pending\":"+(a.gc_pending_finalizers()?std::string("true"):std::string("false")) : std::string())+"}"
        : "null";
    std::ostringstream out;
    out<<"{\"schema\":2,\"coherence\":\"double_read_only\",\"atomic\":false,\"local_player_id\":"<<player
       <<",\"map_token\":\""<<reinterpret_cast<std::uintptr_t>(map_data.get())<<"\",\"map_name\":"
       <<a.string_json(m::field<m::Object*>(a.api,game.get(),"_currentMapName"))
       <<",\"app_mode\":"<<mode<<",\"game_time\":"<<economy.game_time
       <<",\"paused\":"<<(m::field<std::uint8_t>(a.api,state.get(),"game_paused")?"true":"false")
       <<",\"gold\":"<<economy.gold<<",\"population\":"<<economy.population
       <<",\"popularity\":"<<economy.popularity<<",\"tax_index\":"<<economy.tax_index
       <<",\"resources\":[";
    for(std::size_t i=0;i<economy.resources.size();++i){if(i)out<<',';out<<economy.resources[i];}
    out<<"],\"own_troops\":{\"total\":"<<total<<",\"by_type_1_to_34\":["<<counts.str()<<"]}"
       <<",\"structures\":"<<structures<<",\"placement\":"<<placement<<",\"camera\":"<<camera<<",\"managed_heap\":"<<managed_heap
       <<",\"settlement\":"<<settlement<<",\"selected_building\":"<<selected_building
       <<",\"visible_messages\":[";
    bool comma=false;
    for(const char* channel:{"Keep_Message","Message_Bar","Feedback_1"}) {
        const std::string prefix=std::string("_OST_")+channel;
        if(m::field<bool>(a.api,view.get(),(prefix+"_Vis").c_str())) {
            if(comma)out<<',';comma=true;
            out<<"{\"channel\":\""<<channel<<"\",\"text\":"
               <<a.string_json(m::field<m::Object*>(a.api,view.get(),(prefix+"_Text").c_str()))<<'}';
        }
    }
    // Engine placement feedback shares the bottom rollover panel with hover
    // labels. Only report it when the rendered text matches the active panel
    // message; OtherString alone can be stale or hidden by a building tooltip.
    m::Root hud(a.api,m::field<m::Object*>(a.api,view.get(),"HUDmain"));
    const auto panel_group=m::field<std::int16_t>(a.api,state.get(),"panel_text_group");
    const auto panel_text=m::field<std::int16_t>(a.api,state.get(),"panel_text_text");
    if(panel_group>0 &&
       m::field<std::int32_t>(a.api,hud.get(),"lastPTBgroup")==panel_group &&
       m::field<std::int32_t>(a.api,hud.get(),"lastPTBtext")==panel_text &&
       m::field<bool>(a.api,hud.get(),"OtherVisible") &&
       m::field<bool>(a.api,hud.get(),"OtherHighestPri") &&
       !a.stat<bool>(a.cls("MainViewModel","CrusaderDE"),"_rolloverBuilding_TooltipVis",0x02)) {
        const auto text=a.string_json(m::field<m::Object*>(a.api,hud.get(),"OtherString"),true);
        if(text!="null" && text!="\"\"" &&
           text==a.string_json(a.stat<m::Object*>(a.cls("MainViewModel","CrusaderDE"),"_rollOverText",0x0e),true)) {
            if(comma)out<<',';comma=true;
            out<<"{\"channel\":\"Panel_Feedback\",\"text\":"<<text<<'}';
        }
    }
    out<<"]}";
    if(m::field<m::Object*>(a.api,game.get(),"_lastGameState")!=state.get() ||
       m::field<m::Object*>(a.api,map.get(),"gameMap")!=map_data.get() ||
       m::field<std::int32_t>(a.api,editor.get(),"gameLocalPlayerID")!=player ||
       m::field<std::int32_t>(a.api,game.get(),"_app_mode")!=mode)
        throw std::runtime_error("publication or map changed during capture");
    return out.str();
}
