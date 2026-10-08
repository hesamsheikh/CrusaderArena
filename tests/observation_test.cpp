#include "observation.hpp"
#include <cassert>
#include <limits>
#include <vector>
int main() {
    std::vector<std::byte> b(949);
    auto put = [&](std::size_t offset, std::uint32_t v) {
        for (unsigned i=0;i<4;++i) b[1+offset+i]=std::byte((v>>(8*i))&255);
    };
    put(8, 37); put(116, 1234); put(884, 11); put(944, 0xffffffff);
    auto data=std::span<const std::byte>(b).subspan(1);
    auto s=crusader::decode_observation(data);
    assert(s.wood_planks()==37 && s.gold==1234 && s.tax_index==11);
    assert(s.selected_structure==-1);
    put(0,0x80000000);
    assert(crusader::read_i32(data,0)==std::numeric_limits<std::int32_t>::min());
    for (std::size_t n=0;n<948;++n) {
        bool rejected=false;
        try { (void)crusader::decode_observation(data.first(n)); }
        catch (const std::invalid_argument&) { rejected=true; }
        assert(rejected);
    }
    bool rejected=false;
    try { (void)crusader::read_i32(data,std::numeric_limits<std::size_t>::max()); }
    catch (const std::invalid_argument&) { rejected=true; }
    assert(rejected);
}
