#include <windows.h>
#include <cassert>
#include <cstring>
#include <initializer_list>
#include "windows/inspect_protocol.hpp"

extern "C" __declspec(dllimport) DWORD WINAPI CrusaderInspect(void*);

// Run in an ordinary process without Mono: no game attachment required.
int main() {
    using crusader::InspectReport;
    assert(CrusaderInspect(nullptr)==2);
    InspectReport bad;
    bad.magic=0x43424931; // old launcher ABI must fail before runtime access
    assert(CrusaderInspect(&bad)==2);
    bad=InspectReport{};bad.magic=0x43424932;
    assert(CrusaderInspect(&bad)==2);
    bad=InspectReport{};bad.magic=0x43424933;
    assert(CrusaderInspect(&bad)==2);
    bad=InspectReport{};bad.size--;
    assert(CrusaderInspect(&bad)==2);
    bad=InspectReport{};bad.mode=4;
    assert(CrusaderInspect(&bad)==2);
    for(unsigned mode: {0u,1u,2u,3u}) {
        InspectReport report;report.mode=mode;
        assert(CrusaderInspect(&report)==1);
        assert(report.status==1);
        assert(report.used>0 && report.used<sizeof(report.text));
        assert(std::strstr(report.text,"runtime/export missing"));
    }
}
