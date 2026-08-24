/**
 * Stands in for a contract that is not deployed on the network an address file describes.
 *
 * The processors register their log filters unconditionally, and in Subsquid an empty `address` array
 * means ANY address — so a filter for a version that does not exist yet cannot simply omit the address.
 * Pointing it here keeps the filter shape uniform across networks while matching nothing, since no
 * contract can emit from the zero address.
 */
export const Null = "0x0000000000000000000000000000000000000000";
