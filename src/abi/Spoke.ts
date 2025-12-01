import * as p from "@subsquid/evm-codec";
import { event, indexed } from "@subsquid/evm-abi";
import type { EventParams as EParams } from "@subsquid/evm-abi";

export const events = {
  OrderCreated: event(
    "0x15dda46e24f41b28c71ef37367cf2f87209ff6bacbae6f1c94e6c3ccbb8b7e10",
    "OrderCreated(bytes32,(address,address,address,address,address,uint256,uint256,uint256,uint256,uint256,uint256,bytes32))",
    {
      orderHash: indexed(p.bytes32),
      order: p.struct({
        fromAddress: p.address,
        toAddress: p.address,
        filler: p.address,
        fromToken: p.address,
        toToken: p.address,
        expiry: p.uint256,
        fromAmount: p.uint256,
        fillAmount: p.uint256,
        feeRate: p.uint256,
        fromChain: p.uint256,
        toChain: p.uint256,
        postHookHash: p.bytes32,
      }),
    }
  ),
  OrderFilled: event(
    "0x9b2f3b650e7df42afb0e965a1dda8e8b1e128be6e0e8c40e9d3a7d44ab5ecd11",
    "OrderFilled(bytes32,(address,address,address,address,address,uint256,uint256,uint256,uint256,uint256,uint256,bytes32))",
    {
      orderHash: indexed(p.bytes32),
      order: p.struct({
        fromAddress: p.address,
        toAddress: p.address,
        filler: p.address,
        fromToken: p.address,
        toToken: p.address,
        expiry: p.uint256,
        fromAmount: p.uint256,
        fillAmount: p.uint256,
        feeRate: p.uint256,
        fromChain: p.uint256,
        toChain: p.uint256,
        postHookHash: p.bytes32,
      }),
    }
  ),
};

export type OrderCreatedEventArgs = EParams<typeof events.OrderCreated>;
export type OrderFilledEventArgs = EParams<typeof events.OrderFilled>;
