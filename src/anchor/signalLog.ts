import { createWalletClient, http, keccak256, toBytes, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { config } from "../config.js";

const signalLogAbi = parseAbi([
  "function anchor(bytes32 digest, uint64 signalCount, uint64 dayIndex)",
]);

/**
 * Anchor the daily signal digest on Base Sepolia via SignalLog.
 * Uses a project-only testnet wallet (ANCHOR_PRIVATE_KEY) funded from a faucet.
 * If BUILDER_CODE is set, it is appended to the calldata as an ERC-8021
 * attribution suffix so indexers attribute the activity to this agent.
 */
export async function anchorDigest(digestText: string, signalCount: number, dayIndex: number) {
  if (!config.anchorPrivateKey || !config.signalLogAddress) {
    throw new Error("ANCHOR_PRIVATE_KEY / SIGNAL_LOG_ADDRESS not set — deploy SignalLog first (build D7).");
  }
  const account = privateKeyToAccount(config.anchorPrivateKey as `0x${string}`);
  const wallet = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(config.baseSepoliaRpcUrl),
  });
  const digest = keccak256(toBytes(digestText));
  const hash = await wallet.writeContract({
    address: config.signalLogAddress as `0x${string}`,
    abi: signalLogAbi,
    functionName: "anchor",
    args: [digest, BigInt(signalCount), BigInt(dayIndex)],
    // ERC-8021 data suffix for Builder Code attribution (optional).
    ...(config.builderCode ? { dataSuffix: config.builderCode as `0x${string}` } : {}),
  });
  return { digest, hash };
}

// TODO(build D7): deploy script for contracts/SignalLog.sol (compiled artifact
// via the project's Solidity toolchain) + faucet checklist in README.
