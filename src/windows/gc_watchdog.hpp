#pragma once
#include <string>

// Included inside adapter's anonymous namespace, after its bind helper.
// Collector watchdog. Under Proton the game's Boehm collector can stop starting
// collections for good: Wine can report a bogus stack pointer for a suspended thread
// (Wine bug 59333), the collector's total of thread stack sizes wraps, and the allocation
// threshold it caches until the next collection becomes huge. The managed heap then grows
// until the memory guard closes the game. A collection recomputes the threshold, so when
// the count has stood still for 20 s while the heap grew by 64 MiB, the reader asks Mono
// for one full collection, as System.GC.Collect does (Mono only signals its finalizer
// thread; no game code runs here). It first copies the collector globals that show why.
// Their offsets were mapped by disassembly for the fingerprinted mono-2.0-bdwgc.dll only.
struct CollectorWatch {
    int count=-1;ULONGLONG changed_ms=0;std::int64_t used_at_change=0;
    unsigned forced=0;std::string last="null";
};
CollectorWatch& collector_watch(){static CollectorWatch w;return w;}

// {"forced":N,"last":{...}|null} for the observation; stable between the double read.
std::string collector_watch_json() {
    const auto& w=collector_watch();
    return "{\"forced\":"+std::to_string(w.forced)+",\"last\":"+w.last+"}";
}

void watch_collector(HMODULE runtime) {
    constexpr ULONGLONG stall_ms=20000;constexpr std::int64_t growth=64ll<<20;
    int (*count)(int);std::int64_t (*used)();void (*collect)(int);
    if(!bind(runtime,count,"mono_gc_collection_count") || !bind(runtime,used,"mono_gc_get_used_size") ||
       !bind(runtime,collect,"mono_gc_collect"))return;
    auto& w=collector_watch();
    const auto now=GetTickCount64();const int before=count(0);const auto bytes=used();
    if(before!=w.count){w.count=before;w.changed_ms=now;w.used_at_change=bytes;return;}
    if(now-w.changed_ms<stall_ms || bytes-w.used_at_change<growth)return;
    // GC_total_stacksize, the cached threshold (last_min_bytes_allocd in GC_should_collect),
    // GC_dont_gc and GC_disable_automatic_collection, read in place within the image.
    const auto image=reinterpret_cast<const std::uint8_t*>(runtime);
    const auto dos=reinterpret_cast<const IMAGE_DOS_HEADER*>(image);
    const auto nt=reinterpret_cast<const IMAGE_NT_HEADERS64*>(image+dos->e_lfanew);
    const auto global=[&](std::uint32_t rva,std::size_t size)->std::string {
        if(dos->e_magic!=IMAGE_DOS_SIGNATURE || nt->Signature!=IMAGE_NT_SIGNATURE ||
           rva+size>nt->OptionalHeader.SizeOfImage)return "null";
        std::uint64_t v=0;std::memcpy(&v,image+rva,size);return std::to_string(v);
    };
    const auto evidence=",\"total_stack_bytes\":"+global(0x74f0a0,8)+",\"threshold_bytes\":"+global(0x74f3c0,8)+
        ",\"dont_gc\":"+global(0x74f304,4)+",\"automatic_disabled\":"+global(0x74eb08,4);
    LARGE_INTEGER frequency,start,end;
    QueryPerformanceFrequency(&frequency);QueryPerformanceCounter(&start);
    collect(0);
    QueryPerformanceCounter(&end);
    const int after=count(0);
    FILETIME ft;GetSystemTimeAsFileTime(&ft);
    ULARGE_INTEGER epoch;epoch.LowPart=ft.dwLowDateTime;epoch.HighPart=ft.dwHighDateTime;
    w.last="{\"at_unix_ms\":"+std::to_string((epoch.QuadPart-116444736000000000ULL)/10000ULL)+
        ",\"stalled_ms\":"+std::to_string(now-w.changed_ms)+",\"used_growth_bytes\":"+std::to_string(bytes-w.used_at_change)+
        ",\"collections_before\":"+std::to_string(before)+",\"collections_after\":"+std::to_string(after)+
        ",\"collect_ms\":"+std::to_string((end.QuadPart-start.QuadPart)*1000/frequency.QuadPart)+evidence+"}";
    ++w.forced;w.count=after;w.changed_ms=GetTickCount64();w.used_at_change=used();
}
