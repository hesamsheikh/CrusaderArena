#pragma once
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <type_traits>
#include "observation.hpp"

namespace crusader::managed {
struct Object; struct Class; struct Field; struct Array; struct Type;
// Opaque runtime objects; never assume the bundled Mono object's memory layout.
struct Api {
    Class* (*object_class)(Object*);
    Class* (*element_class)(Class*);
    Type* (*field_type)(Field*);
    int (*type_kind)(Type*);
    int (*type_reference)(Type*);
    const char* (*class_name)(Class*);
    const char* (*class_namespace)(Class*);
    Field* (*field_named)(Class*,const char*);
    void (*field_get)(Object*,Field*,void*);
    std::uint32_t (*pin)(Object*,int);
    void (*unpin)(std::uint32_t);
    Object* (*target)(std::uint32_t);
    std::uintptr_t (*array_length)(Array*);
    char* (*array_address)(Array*,int,std::uintptr_t);
    explicit Api(HMODULE runtime) {
        if(!runtime)throw std::runtime_error("bundled Mono module missing");
        bind(runtime,element_class,"mono_class_get_element_class");
        bind(runtime,field_type,"mono_field_get_type");
        bind(runtime,type_kind,"mono_type_get_type");
        bind(runtime,type_reference,"mono_type_is_reference");
        bind(runtime,class_name,"mono_class_get_name");
        bind(runtime,class_namespace,"mono_class_get_namespace");
        bind(runtime,object_class,"mono_object_get_class");
        bind(runtime,field_named,"mono_class_get_field_from_name");
        bind(runtime,field_get,"mono_field_get_value");
        bind(runtime,pin,"mono_gchandle_new");
        bind(runtime,unpin,"mono_gchandle_free");
        bind(runtime,target,"mono_gchandle_get_target");
        bind(runtime,array_length,"mono_array_length");
        bind(runtime,array_address,"mono_array_addr_with_size");
    }
private:
    template<class T> static void bind(HMODULE m,T& f,const char* name) {
        auto address=GetProcAddress(m,name);
        if(!address)throw std::runtime_error(name);
        static_assert(sizeof(f)==sizeof(address));
        std::memcpy(&f,&address,sizeof(f));
    }
};
struct Root {
    Api& api;std::uint32_t handle;
    Root(Api& a,Object* o):api(a),handle(o?a.pin(o,1):0) {
        if(!handle)throw std::runtime_error("managed object unavailable");
    }
    ~Root(){api.unpin(handle);}
    Root(const Root&)=delete;
    Object* get()const{return api.target(handle);}
};
template<class T> T field(Api& a,Object* object,const char* name) {
    if(!object)throw std::runtime_error("managed snapshot unavailable");
    auto f=a.field_named(a.object_class(object),name);
    if(!f)throw std::runtime_error(name);
    const int kind=a.type_kind(a.field_type(f));
    if constexpr(std::is_same_v<T,std::int32_t>) {
        if(kind!=0x08)throw std::runtime_error("expected Int32 field");
    } else if constexpr(std::is_same_v<T,std::int16_t>) {
        if(kind!=0x06)throw std::runtime_error("expected Int16 field");
    } else if constexpr(std::is_same_v<T,bool>) {
        if(kind!=0x02)throw std::runtime_error("expected Boolean field");
    } else if constexpr(std::is_same_v<T,std::uint8_t>) {
        if(kind!=0x05)throw std::runtime_error("expected Byte field");
    } else if constexpr(std::is_same_v<T,float>) {
        if(kind!=0x0c)throw std::runtime_error("expected Single field");
    } else {
        static_assert(std::is_same_v<T,Object*>);
        if((kind!=0x0e && kind!=0x12 && kind!=0x14 && kind!=0x1d && kind!=0x15) || !a.type_reference(a.field_type(f)))throw std::runtime_error("expected object/array field");
    }
    T value{};a.field_get(object,f,&value);return value;
}
// Preconditions: version gate passed, caller attached to the correct live Mono
// domain, and game_data is a rooted GameData instance. Domain unload must be
// excluded by the capture lifecycle. This does not establish those preconditions.
inline void require_class(Api& api,Object* object,const char* name) {
    if(!object)throw std::runtime_error("managed object unavailable");
    auto c=api.object_class(object);
    if(std::strcmp(api.class_name(c),name)!=0 || std::strcmp(api.class_namespace(c),"")!=0)
        throw std::runtime_error("unexpected managed class");
}
inline Observation read_published_snapshot(Api& api,Object* game_data) {
    require_class(api,game_data,"GameData");
    Root state(api,field<Object*>(api,game_data,"_lastGameState"));
    require_class(api,state.get(),"PlayState");
    Root resources(api,field<Object*>(api,state.get(),"resources"));
    auto element=api.element_class(api.object_class(resources.get()));
    if(!element || std::strcmp(api.class_name(element),"Int32")!=0 ||
       std::strcmp(api.class_namespace(element),"System")!=0)
        throw std::runtime_error("expected Int32 resource array");
    auto array=reinterpret_cast<Array*>(resources.get());
    if(api.array_length(array)!=25)throw std::runtime_error("unexpected resource array length");
    Observation out{};
    for(std::size_t i=0;i<out.resources.size();++i)
        std::memcpy(&out.resources[i],api.array_address(array,4,i),4);
    out.gold=field<std::int32_t>(api,state.get(),"gold");
    out.population=field<std::int32_t>(api,state.get(),"population");
    out.popularity=field<std::int32_t>(api,state.get(),"popularity");
    out.tax_index=field<std::int32_t>(api,state.get(),"tax_rate");
    out.app_mode=field<std::int32_t>(api,state.get(),"app_mode");
    out.game_time=field<std::int32_t>(api,state.get(),"game_time");
    out.selected_structure=field<std::int32_t>(api,state.get(),"in_structure");
    // Reject an observation straddling publication; caller may retry later.
    if(field<Object*>(api,game_data,"_lastGameState")!=state.get())
        throw std::runtime_error("snapshot changed during capture");
    return out;
}
} // namespace crusader::managed
