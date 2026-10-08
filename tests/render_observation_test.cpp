#include "render_observation.hpp"
#include <array>
#include <cassert>
#include <limits>
int main() {
    std::array<std::int16_t,84> b{};
    b[0]=2;b[3]=442;b[10]=123;b[1]=-10;b[2]=20;b[8]=33;b[9]=44;
    b[20]=0x0307;b[7]=0x4005;
    b[21]=53; // auxiliary visual data, not another troop
    b[42]=2;b[45]=0;b[52]=123;
    b[63]=1; // scenery, not troop
    auto d=crusader::decode_troop_render_deltas(b,4);
    assert(d.size()==2 && !d[0].removed && d[1].removed);
    assert(d[0].object_id==123 && d[1].object_id==123);
    assert(d[0].x==-10 && d[0].tile_x==33 && d[0].tile_y==44);
    assert(d[0].game_object_type==7 && d[0].color_code==5 && d[0].in_journey);
    assert(crusader::decode_troop_render_deltas(b,0).empty());
    for (auto rows : {std::size_t(5),std::numeric_limits<std::size_t>::max()}) {
        bool rejected=false;
        try { (void)crusader::decode_troop_render_deltas(b,rows); }
        catch (const std::invalid_argument&) { rejected=true; }
        assert(rejected);
    }
}
