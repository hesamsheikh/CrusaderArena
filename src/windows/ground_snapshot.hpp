#pragma once
#include "managed_snapshot.hpp"
#include <initializer_list>

namespace crusader::managed {
struct GroundSprite {
    int file=-1;
    int image=-1;
    int alternate=-1;
    unsigned matches=0;
};
// Reverse lookup by object identity in selected, statically verified ground
// sheets. A sprite may have aliases; preserve the match count, never infer
// fertility or resource availability from an image alone.
inline GroundSprite ground_sprite(Api& api,Object* loader,Object* sprite,
                                 int (*rank)(Class*)) {
    GroundSprite out;
    if(!sprite)return out;
    Root target(api,sprite);
    auto sc=api.object_class(target.get());
    if(std::strcmp(api.class_name(sc),"Sprite") ||
       std::strcmp(api.class_namespace(sc),"UnityEngine"))
        throw std::runtime_error("unexpected tile sprite type");
    require_class(api,loader,"spriteLoader");
    const char* fields[]={"gmSprites","gmAltSprites"};
    for(int variant=0;variant<2;++variant) {
        Root table(api,field<Object*>(api,loader,fields[variant]));
        auto outer=reinterpret_cast<Array*>(table.get());
        if(rank(api.object_class(table.get()))!=1 || api.array_length(outer)>512)
            throw std::runtime_error("invalid ground sprite table");
        auto sheet_class=api.element_class(api.object_class(table.get()));
        if(!sheet_class || rank(sheet_class)!=1)
            throw std::runtime_error("expected sprite array table");
        auto element=api.element_class(sheet_class);
        if(!element || std::strcmp(api.class_name(element),"Sprite") ||
           std::strcmp(api.class_namespace(element),"UnityEngine"))
            throw std::runtime_error("expected Sprite[][]");
        for(int file: {2,5,12,14,55,56,60}) {
            if(static_cast<unsigned>(file)>=api.array_length(outer))continue;
            Object* raw=nullptr;
            std::memcpy(&raw,api.array_address(outer,sizeof(raw),file),sizeof(raw));
            if(!raw)continue;
            Root sheet(api,raw);
            auto array=reinterpret_cast<Array*>(sheet.get());
            const auto count=api.array_length(array);
            if(count>4096)throw std::runtime_error("ground sprite sheet too large");
            for(std::uintptr_t i=0;i<count;++i) {
                Object* candidate=nullptr;
                std::memcpy(&candidate,api.array_address(array,sizeof(candidate),i),sizeof(candidate));
                if(candidate==target.get()) {
                    if(!out.matches) {out.file=file;out.image=static_cast<int>(i);out.alternate=variant;}
                    ++out.matches;
                }
            }
            Object* again=nullptr;
            std::memcpy(&again,api.array_address(outer,sizeof(again),file),sizeof(again));
            if(again!=sheet.get())throw std::runtime_error("ground sprite sheet replaced");
        }
        if(field<Object*>(api,loader,fields[variant])!=table.get())
            throw std::runtime_error("ground sprite table replaced");
    }
    return out;
}
} // namespace crusader::managed
