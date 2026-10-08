#pragma once
#include <cstdint>
#include <span>
#include <stdexcept>
#include <vector>

namespace crusader {
// Decodes primary troop render deltas only. Coordinates are raw engine values;
// color is not yet a player ID; removal does not imply death. Caller supplies
// the game's returned row count and a coherent copied Int16 buffer.
struct TroopRenderDelta {
    std::int32_t object_id;
    bool removed;
    std::int32_t x, y, tile_x, tile_y, game_object_type, color_code;
    bool in_journey;
};
inline std::vector<TroopRenderDelta> decode_troop_render_deltas(
    std::span<const std::int16_t> words, std::size_t rows) {
    constexpr std::size_t stride = 21;
    if (rows > words.size()/stride)
        throw std::invalid_argument("render row count exceeds buffer");
    std::vector<TroopRenderDelta> result;
    for (std::size_t i=0;i<rows;++i) {
        auto row=words.subspan(i*stride,stride);
        if (row[0]!=2) continue;
        TroopRenderDelta delta{};
        delta.object_id=row[10];
        delta.removed=row[3]==0;
        if (!delta.removed) {
            delta.x=row[1]; delta.y=row[2];
            delta.tile_x=row[8]; delta.tile_y=row[9];
            delta.game_object_type=static_cast<std::uint16_t>(row[20])&255;
            delta.color_code=static_cast<std::uint16_t>(row[7])&16383;
            delta.in_journey=(static_cast<std::uint16_t>(row[7])&16384)!=0;
        }
        result.push_back(delta);
    }
    return result;
}
} // namespace crusader
