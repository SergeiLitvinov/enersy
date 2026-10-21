#include "enersy_numerics.h"
#include <stddef.h>
_Static_assert(sizeof(void *)==8, "ABI v1 is 64-bit");
_Static_assert(sizeof(enersy_u64_input)==16, "slice layout");
_Static_assert(sizeof(enersy_plan_info)==24, "info layout");
_Static_assert(sizeof(enersy_demand)==40, "demand layout");
_Static_assert(offsetof(enersy_demand,p_i)==8, "demand alignment");
_Static_assert(offsetof(enersy_demand,q_z)==32, "demand layout");
