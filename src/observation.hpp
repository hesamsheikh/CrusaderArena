#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <span>
#include <stdexcept>

namespace crusader {
// Offsets apply only to PlayStateReturnData from the fingerprinted build.
// Caller must capture a coherent buffer while its native lifetime is valid.
struct Observation {
    std::array<std::int32_t, 25> resources;
    std::int32_t popularity, population, gold, tax_index, app_mode, game_time;
    std::int32_t selected_structure;
    std::int32_t wood_planks() const { return resources[2]; }
};
inline std::int32_t read_i32(std::span<const std::byte> bytes, std::size_t offset) {
    if (offset > bytes.size() || bytes.size() - offset < 4)
        throw std::invalid_argument("truncated state buffer");
    std::uint32_t value = 0;
    for (unsigned i = 0; i < 4; ++i)
        value |= std::to_integer<std::uint32_t>(bytes[offset + i]) << (i * 8);
    // Preserve signed values without implementation-defined unsigned conversion.
    if (value <= 0x7fffffffU) return static_cast<std::int32_t>(value);
    return -1 - static_cast<std::int32_t>(0xffffffffU - value);
}
inline Observation decode_observation(std::span<const std::byte> bytes) {
    if (bytes.size() < 948) throw std::invalid_argument("truncated state buffer");
    Observation s{};
    for (std::size_t i = 0; i < s.resources.size(); ++i)
        s.resources[i] = read_i32(bytes, i * 4);
    s.popularity = read_i32(bytes, 108);
    s.population = read_i32(bytes, 112);
    s.gold = read_i32(bytes, 116);
    s.tax_index = read_i32(bytes, 884);
    s.app_mode = read_i32(bytes, 928);
    s.game_time = read_i32(bytes, 940);
    s.selected_structure = read_i32(bytes, 944);
    return s;
}
} // namespace crusader
