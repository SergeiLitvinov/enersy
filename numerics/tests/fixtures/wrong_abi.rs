// Negative loader fixture only: never a numerical implementation.
#[no_mangle]
pub extern "C" fn enersy_numerics_abi_version() -> u32 {
    999
}
