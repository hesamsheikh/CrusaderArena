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
    int (*gc_disabled)()=nullptr;
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
        if(!bind(runtime,gc_disabled,"mono_unity_gc_is_disabled"))gc_disabled=nullptr;
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
    // The tile under the mouse pointer, as the game picks it for a click (terrain height included),
    // which a pointer move updates without a click. The engine keeps it in its own tile grid, which
    // runs the other way on both axes; the camera's centre tile, kept in both, turns it into map tiles.
    const auto mouse_tile=optional([&]()->std::string {
        const auto u=m::field<float>(a.api,editor.get(),"mouseTileX");
        const auto v=m::field<float>(a.api,editor.get(),"mouseTileY");
        if(!std::isfinite(u) || !std::isfinite(v))throw std::runtime_error("non-finite mouse tile");
        auto f=a.api.field_named(a.api.object_class(map.get()),"cachecCentreTileMapVector");
        if(!f || a.api.type_kind(a.api.field_type(f))!=0x11)throw std::runtime_error("centre tile vector missing");
        std::int32_t centre[16]={};a.api.field_get(map.get(),f,centre);
        const auto x0=m::field<std::int32_t>(a.api,map.get(),"screenCentreTileX");
        const auto y0=m::field<std::int32_t>(a.api,map.get(),"screenCentreTileY");
        // The engine grid's last index, the same from both axes, or the reading is not trusted.
        const auto last=x0+centre[1];
        if(y0+centre[0]!=last)throw std::runtime_error("tile grids disagree");
        return "{\"x\":"+std::to_string(last-std::lround(v))+",\"y\":"+std::to_string(last-std::lround(u))+"}";
    });
    // Settlement context from the same PlayState (calendar, housing, food, popularity
    // factors, the church and cathedral bonus, the keep's tax figure). Optional; field meanings
    // beyond the names need UI validation. The church bonus is optional on its own (null when
    // unreadable), so it cannot take the rest of the settlement with it.
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
         <<",\"church_bonus\":"<<optional([&]{return std::to_string(m::field<std::int8_t>(a.api,state.get(),"church_adjustment"));})
         <<",\"tax_amount\":"<<i16("tax_amount")
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
    // The engine's building records: 0x32c bytes per instance id, the type at the mapped address
    // and, relative to it, the owner (+0x04), top-left tile (+0x1c, +0x1e), amount (+0xb2),
    // capacity (+0xb6) and, for stockpile piles, the good (+0xba). Mapped live on Oasis by the Sea,
    // 2026-10-09; the owner field was only seen with player 1. Plain reads of the engine's static
    // records, bounds-checked against its image; no engine function is called. Returns the highest
    // instance id and a reader of one 16-bit field.
    const auto building_records=[&]() {
        const auto engine=reinterpret_cast<const std::uint8_t*>(GetModuleHandleW(L"CrusaderDE.dll"));
        if(!engine)throw std::runtime_error("engine module missing");
        const auto dos=reinterpret_cast<const IMAGE_DOS_HEADER*>(engine);
        const auto nt=reinterpret_cast<const IMAGE_NT_HEADERS64*>(engine+dos->e_lfanew);
        if(dos->e_magic!=IMAGE_DOS_SIGNATURE || nt->Signature!=IMAGE_NT_SIGNATURE)
            throw std::runtime_error("engine image headers unexpected");
        constexpr std::uint64_t type_rva=0x64cccde,stride=0x32c;
        const int limit=i16("structs_limit");
        if(limit<1 || limit>10000 || type_rva+std::uint64_t(limit+1)*stride>nt->OptionalHeader.SizeOfImage)
            throw std::runtime_error("building records outside engine image");
        const auto at=[engine](int id,int offset){std::int16_t v;std::memcpy(&v,engine+type_rva+std::uint64_t(id)*stride+offset,2);return int(v);};
        return std::make_pair(limit,at);
    };
    // The local player's stockpile piles (type 10: a stockpile is four 2x2 piles, each holding one
    // good) and granaries (type 19). An empty pile has amount 0 and capacity 0 and keeps its last
    // good. Optional.
    // Armories (type 11) the same way as granaries: all weapons and armour together, the amount and
    // capacity at the same offsets (live on The Sinkhole, 2026-10-12: 50 items of any mix, then the
    // market refused more; an empty armory reads 0 and 0).
    const auto storage=optional([&]()->std::string {
        const auto [limit,at]=building_records();
        std::ostringstream piles,granaries,armories;int pile_count=0,granary_count=0,armory_count=0;bool truncated=false;
        for(int id=1;id<=limit;++id) {
            const int type=at(id,0);
            if((type!=10 && type!=19 && type!=11) || at(id,0x04)!=player)continue;
            if(type==10) {
                if(pile_count==128){truncated=true;continue;}
                piles<<(pile_count++?",":"")<<'['<<at(id,0x1c)<<','<<at(id,0x1e)<<','<<at(id,0xba)<<','<<at(id,0xb2)<<','<<at(id,0xb6)<<']';
            } else if(type==19) {
                if(granary_count==32){truncated=true;continue;}
                granaries<<(granary_count++?",":"")<<'['<<at(id,0x1c)<<','<<at(id,0x1e)<<','<<at(id,0xb2)<<','<<at(id,0xb6)<<']';
            } else {
                if(armory_count==32){truncated=true;continue;}
                armories<<(armory_count++?",":"")<<'['<<at(id,0x1c)<<','<<at(id,0x1e)<<','<<at(id,0xb2)<<','<<at(id,0xb6)<<']';
            }
        }
        return "{\"piles\":["+piles.str()+"],\"granaries\":["+granaries.str()+"],\"armories\":["+armories.str()+"],\"truncated\":"+(truncated?"true":"false")+"}";
    });
    // The local player's building records counted by engine type, keyed by the type number. Parts
    // the engine keeps as records of their own count too: a stockpile's four piles, a quarry's
    // pile, the keep's doors. Counted live on both reference games' end saves, 2026-10-10. Optional.
    const auto buildings=optional([&]()->std::string {
        const auto [limit,at]=building_records();
        int counts[512]={};
        for(int id=1;id<=limit;++id) {
            const int type=at(id,0);
            if(type>0 && type<512 && at(id,0x04)==player)counts[type]++;
        }
        std::ostringstream s;s<<'{';bool first=true;
        for(int type=1;type<512;++type)if(counts[type]){s<<(first?"":",")<<'"'<<type<<"\":"<<counts[type];first=false;}
        s<<'}';
        return s.str();
    });
    // The local player's jobs: over its buildings with workers (needed above 0), the workers needed
    // (+0xc6), there (+0xc8) and the places open (+0xca), as each building's panel shows them (a new
    // woodcutter on Large Barren Desert's start with nobody idle read 1, 0 and 1 there and on its
    // panel, live 2026-10-15). Optional.
    const auto jobs=optional([&]()->std::string {
        const auto [limit,at]=building_records();
        int needed=0,filled=0,open=0;
        for(int id=1;id<=limit;++id) {
            if(at(id,0)<=0 || at(id,0x04)!=player)continue;
            const int n=at(id,0xc6),have=at(id,0xc8),vacant=at(id,0xca);
            // A record whose words do not read as workers (a type that uses them otherwise) is left out.
            if(n<=0 || n>64 || have<0 || have>n || vacant<0 || vacant>n)continue;
            needed+=n;filled+=have;open+=vacant;
        }
        return "{\"needed\":"+std::to_string(needed)+",\"filled\":"+std::to_string(filled)+",\"open\":"+std::to_string(open)+"}";
    });
    // What the open panel's workshop makes, for the fletcher (12), blacksmith (13) and poleturner
    // (14), whose panels choose between two products: goods numbers (as in resources) in its
    // building record, the one in progress at +0x1bc and the next at +0x1be, which the panel's two
    // buttons set (live on Oasis by the Sea, 2026-10-12). Null without such a panel. Optional.
    const auto selected_workshop=optional([&]()->std::string {
        const auto id=i32("in_structure");
        if(id<=0)return "null";
        const auto [limit,at]=building_records();
        if(id>limit)return "null";
        const int type=at(id,0);
        if(type<12 || type>14)return "null";
        return "{\"id\":"+std::to_string(id)+",\"type\":"+std::to_string(type)+
            ",\"making\":"+std::to_string(at(id,0x1bc))+",\"next\":"+std::to_string(at(id,0x1be))+"}";
    });
    // The starting goods, as the list at the top left of the screen shows them while they arrive:
    // the on-screen text's last values, by goods number as in resources. Optional.
    const auto starting_goods=optional([&]()->std::string {
        m::Root text(a.api,a.singleton("OnScreenText"));
        m::Root values(a.api,m::field<m::Object*>(a.api,text.get(),"lastStartingGoodsValues"));
        auto element=a.api.element_class(a.api.object_class(values.get()));
        auto array=reinterpret_cast<m::Array*>(values.get());
        const auto n=a.api.array_length(array);
        if(!element || std::strcmp(a.api.class_name(element),"Int32") ||
           std::strcmp(a.api.class_namespace(element),"System") || n>64)
            throw std::runtime_error("starting goods array metadata mismatch");
        std::ostringstream s;s<<'[';
        for(std::uintptr_t i=0;i<n;++i){std::int32_t v;std::memcpy(&v,a.api.array_address(array,4,i),4);s<<(i?",":"")<<v;}
        s<<']';
        return s.str();
    });
    const std::string managed_heap=a.gc_heap_size
        ? "{\"heap_bytes\":"+std::to_string(a.gc_heap_size())+",\"used_bytes\":"+std::to_string(a.gc_used_size())+
          (a.gc_collections ? ",\"collections\":"+std::to_string(a.gc_collections(0))+
             ",\"finalizers_pending\":"+(a.gc_pending_finalizers()?std::string("true"):std::string("false")) : std::string())+
          (a.gc_disabled ? ",\"gc_disabled\":"+(a.gc_disabled()?std::string("true"):std::string("false")) : std::string())+
          ",\"watchdog\":"+collector_watch_json()+"}"
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
       <<",\"structures\":"<<structures<<",\"placement\":"<<placement<<",\"camera\":"<<camera<<",\"mouse_tile\":"<<mouse_tile<<",\"managed_heap\":"<<managed_heap
       <<",\"settlement\":"<<settlement<<",\"selected_building\":"<<selected_building<<",\"storage\":"<<storage
       <<",\"buildings\":"<<buildings<<",\"jobs\":"<<jobs<<",\"selected_workshop\":"<<selected_workshop<<",\"starting_goods\":"<<starting_goods
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
