#pragma once
#include <cstdint>
namespace crusader {
inline constexpr std::uint32_t inspect_magic=0x43424934;
struct InspectReport {
    std::uint32_t magic=inspect_magic;
    std::uint32_t size=sizeof(InspectReport);
    std::uint32_t status=1;
    std::uint32_t used=0;
    std::uint32_t mode=0; // 0: discovery, 1: legacy full sample, 2: economy only, 3: repeatable general observation
    char text[16384]{};
};
}
