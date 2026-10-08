#pragma once
#include <cstring>
#include "inspect_protocol.hpp"

// Included after the process/fingerprint utilities in probe.cpp.
namespace crusader {
inline MODULEENTRY32W remote_module(DWORD pid,const std::wstring& filename) {
    Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPMODULE|TH32CS_SNAPMODULE32,pid));
    if(snapshot.value==INVALID_HANDLE_VALUE)throw std::runtime_error("module enumeration failed");
    MODULEENTRY32W m{};m.dwSize=sizeof(m);
    if(!Module32FirstW(snapshot.value,&m))throw std::runtime_error("module list unavailable");
    do {if(_wcsicmp(m.szModule,filename.c_str())==0)return m;}
    while(Module32NextW(snapshot.value,&m));
    return {};
}
struct RemoteBuffer {
    HANDLE process;void* address;bool releasable=true;
    RemoteBuffer(HANDLE p,std::size_t size):process(p),address(VirtualAllocEx(p,nullptr,size,MEM_COMMIT|MEM_RESERVE,PAGE_READWRITE)) {
        if(!address)throw std::runtime_error("remote buffer allocation failed");
    }
    ~RemoteBuffer(){if(releasable)VirtualFreeEx(process,address,0,MEM_RELEASE);}
    RemoteBuffer(const RemoteBuffer&)=delete;
    void write(const void* data,std::size_t size) {
        SIZE_T written=0;
        if(!WriteProcessMemory(process,address,data,size,&written)||written!=size)
            throw std::runtime_error("remote buffer write failed");
    }
};
inline DWORD run_remote(HANDLE process,std::uintptr_t fn,RemoteBuffer& argument) {
    auto start=reinterpret_cast<LPTHREAD_START_ROUTINE>(fn);
    Handle thread(CreateRemoteThread(process,nullptr,0,start,argument.address,0,nullptr));
    if(!thread.value)throw std::runtime_error("inspection thread creation failed");
    const auto wait=WaitForSingleObject(thread.value,15000);
    if(wait!=WAIT_OBJECT_0) {
        // The target may still use the argument. Never terminate its thread or
        // free its memory after a timeout. Restart the game before retrying.
        argument.releasable=false;
        throw std::runtime_error("inspection timed out; restart game before retrying; target thread was not terminated");
    }
    DWORD code=0;
    if(!GetExitCodeThread(thread.value,&code))throw std::runtime_error("thread result unavailable");
    return code;
}
inline std::uintptr_t remote_system_export(DWORD pid,const char* name) {
    auto proc=GetProcAddress(GetModuleHandleW(L"kernel32.dll"),name);
    if(!proc)throw std::runtime_error("Windows loader function unavailable");
    MEMORY_BASIC_INFORMATION region{};
    if(!VirtualQuery(reinterpret_cast<void*>(proc),&region,sizeof(region)))
        throw std::runtime_error("Windows loader module unavailable");
    wchar_t path[32768];
    if(!GetModuleFileNameW(static_cast<HMODULE>(region.AllocationBase),path,32768))
        throw std::runtime_error("Windows loader path unavailable");
    auto module=remote_module(pid,std::filesystem::path(path).filename().wstring());
    if(!module.modBaseAddr || sha256(path)!=sha256(module.szExePath))
        throw std::runtime_error("Windows loader module mismatch");
    const auto offset=reinterpret_cast<std::uintptr_t>(proc)-reinterpret_cast<std::uintptr_t>(region.AllocationBase);
    if(offset>=module.modBaseSize)throw std::runtime_error("Windows loader offset invalid");
    return reinterpret_cast<std::uintptr_t>(module.modBaseAddr)+offset;
}
inline void inspect_in_game(DWORD pid,const std::filesystem::path& game_exe, std::uint32_t mode=0, unsigned samples=1, unsigned interval_ms=500) {
    const auto mutex_name=L"Local\\CrusaderEnv-Inspect-"+std::to_wstring(pid);
    Handle mutex(CreateMutexW(nullptr,TRUE,mutex_name.c_str()));
    if(!mutex.value||GetLastError()==ERROR_ALREADY_EXISTS)
        throw std::runtime_error("another inspection is active");
    struct Unlock {HANDLE h;~Unlock(){ReleaseMutex(h);}} unlock{mutex.value};
    Handle process(OpenProcess(PROCESS_CREATE_THREAD|PROCESS_VM_OPERATION|PROCESS_VM_WRITE|
                               PROCESS_VM_READ|PROCESS_QUERY_INFORMATION|SYNCHRONIZE,FALSE,pid));
    if(!process.value)throw std::runtime_error("cannot open game for adapter inspection");
    wchar_t current[32768];DWORD length=32768;
    if(!QueryFullProcessImageNameW(process.value,0,current,&length)||
       _wcsicmp(current,game_exe.c_str())!=0||WaitForSingleObject(process.value,0)!=WAIT_TIMEOUT)
        throw std::runtime_error("game process changed; rerun fingerprint probe");
    wchar_t own_path[32768];
    auto n=GetModuleFileNameW(nullptr,own_path,32768);
    if(!n||n>=32768)throw std::runtime_error("launcher path unavailable");
    auto dll=std::filesystem::path(own_path).parent_path()/L"crusader_adapter.dll";
    if(mode==3) {
        const auto immutable=dll.parent_path()/(L"crusader_reader_"+std::filesystem::path(sha256(dll)).wstring()+L".dll");
        if(!std::filesystem::exists(immutable))std::filesystem::copy_file(dll,immutable);
        if(sha256(immutable)!=sha256(dll))throw std::runtime_error("reader copy mismatch");
        dll=immutable;
    }
    FILETIME created,exited,kernel,user;
    if(!GetProcessTimes(process.value,&created,&exited,&kernel,&user))
        throw std::runtime_error("process creation time unavailable");
    const auto unsafe=dll.parent_path()/("reader-unsafe-"+std::to_string(pid)+"-"+
        std::to_string(created.dwHighDateTime)+"-"+std::to_string(created.dwLowDateTime));
    if(std::filesystem::exists(unsafe))throw std::runtime_error("prior reader call interrupted; restart game before retrying");
    const auto checked_call=[&](std::uintptr_t function,RemoteBuffer& argument) {
        {std::ofstream marker(unsafe);marker<<"Remote call in progress. Restart this game process if interrupted.\n";
         if(!marker)throw std::runtime_error("cannot create reader interruption marker");}
        const auto result=run_remote(process.value,function,argument);
        std::filesystem::remove(unsafe);
        return result;
    };
    HMODULE local=LoadLibraryExW(dll.c_str(),nullptr,DONT_RESOLVE_DLL_REFERENCES);
    if(!local)throw std::runtime_error("adjacent adapter DLL missing or invalid");
    struct Unmap {HMODULE h;~Unmap(){FreeLibrary(h);}} unmap{local};
    auto entry=GetProcAddress(local,"CrusaderInspect");
    if(!entry)throw std::runtime_error("adapter inspection export missing");
    const auto offset=reinterpret_cast<std::uintptr_t>(entry)-reinterpret_cast<std::uintptr_t>(local);
    auto loaded=remote_module(pid,dll.filename().wstring());
    if(loaded.modBaseAddr && mode!=3)throw std::runtime_error("adapter already loaded; restart the game before another inspection");
    if(!loaded.modBaseAddr) {
        const auto load=remote_system_export(pid,"LoadLibraryW");
        auto path=dll.wstring();RemoteBuffer name(process.value,(path.size()+1)*sizeof(wchar_t));
        name.write(path.c_str(),(path.size()+1)*sizeof(wchar_t));
        (void)checked_call(load,name); // HMODULE cannot fit in DWORD.
        loaded=remote_module(pid,dll.filename().wstring());
    }
    if(!loaded.modBaseAddr||_wcsicmp(loaded.szExePath,dll.c_str())!=0||offset>=loaded.modBaseSize)
        throw std::runtime_error("expected adapter was not loaded");
    const auto epoch_ms=[]() {
        FILETIME ft;GetSystemTimeAsFileTime(&ft);
        ULARGE_INTEGER n;n.LowPart=ft.dwLowDateTime;n.HighPart=ft.dwHighDateTime;
        return (n.QuadPart-116444736000000000ULL)/10000ULL;
    };
    RemoteBuffer payload(process.value,sizeof(InspectReport));
    for(unsigned sequence=0; samples==0 || sequence<samples; ++sequence) {
        if(WaitForSingleObject(process.value,0)!=WAIT_TIMEOUT) {
            std::cout<<"{\"status\":\"game_exited\"}"<<std::endl;return;
        }
        InspectReport report;report.mode=mode;payload.write(&report,sizeof(report));
        const auto started=epoch_ms();
        const auto status=checked_call(reinterpret_cast<std::uintptr_t>(loaded.modBaseAddr)+offset,payload);
        if(mode==3 && WaitForSingleObject(process.value,0)!=WAIT_TIMEOUT) {
            std::cout<<"{\"status\":\"game_exited\"}"<<std::endl;return;
        }
        SIZE_T read=0;
        if(!ReadProcessMemory(process.value,payload.address,&report,sizeof(report),&read)||read!=sizeof(report))
            throw std::runtime_error("inspection report unavailable");
        if(report.magic!=crusader::inspect_magic||report.size!=sizeof(report)||report.used>=sizeof(report.text))
            throw std::runtime_error("invalid inspection report");
        if(mode==3) {
            if(status==5 && report.status==5) {
                std::cout<<"{\"status\":\"game_exiting\"}"<<std::endl;return;
            }
            if(status || report.status)std::cout<<"Reader diagnostic: "<<report.text<<std::endl;
            std::cout<<"{\"status\":\""<<((status||report.status)?"unavailable":"ok")
                     <<"\",\"sequence\":"<<sequence<<",\"capture_started_unix_ms\":"<<started
                     <<",\"captured_unix_ms\":"<<epoch_ms()<<",\"observation\":";
            if(!status && !report.status)std::cout.write(report.text,report.used);
            else {std::cout<<"null";std::cerr.write(report.text,report.used);}
            std::cout<<"}"<<std::endl;
            if((status && status!=4) || (report.status && report.status!=4))
                throw std::runtime_error("reader failed; restart game before retrying");
            if(samples==0 || sequence+1<samples)WaitForSingleObject(process.value,interval_ms);
        } else {
            std::cout.write(report.text,report.used);
            if(status||report.status)throw std::runtime_error("adapter inspection failed");
            std::cout<<"Inspection finished. Adapter stays idle until game exit. No game commands were issued.\n";
        }
    }
}
}
