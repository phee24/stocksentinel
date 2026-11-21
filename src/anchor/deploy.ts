import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { config } from "../config.js";

/**
 * Deploy contracts/SignalLog.sol to Base Sepolia (build D7).
 *
 * Compiles with the local Foundry toolchain in a throwaway project dir,
 * deploys from the project testnet wallet (ANCHOR_PRIVATE_KEY in .env —
 * a project-only wallet funded from a Base Sepolia faucet, NEVER a wallet
 * holding real funds), and prints the address + tx hash to paste into .env
 * as SIGNAL_LOG_ADDRESS.
 *
 * Run: npx tsx src/anchor/deploy.ts
 */
async function main(): Promise<void> {
  if (!config.anchorPrivateKey) {
    throw new Error("ANCHOR_PRIVATE_KEY not set in .env — generate a project testnet wallet and fund it from a Base Sepolia faucet first.");
  }
  const account = privateKeyToAccount(config.anchorPrivateKey as `0x${string}`);
  const pub = createPublicClient({ chain: baseSepolia, transport: http(config.baseSepoliaRpcUrl) });
  const balance = await pub.getBalance({ address: account.address });
  console.log(`deployer ${account.address} balance ${Number(balance) / 1e18} ETH (Base Sepolia)`);
  if (balance === 0n) throw new Error("deployer has 0 Base Sepolia ETH — fund it from a faucet first.");

  const sol = await readFile(new URL("../../contracts/SignalLog.sol", import.meta.url), "utf8");
  const dir = await mkdtemp(join(tmpdir(), "signallog-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "foundry.toml"), '[profile.default]\nsrc = "src"\nout = "out"\n');
  await writeFile(join(dir, "src", "SignalLog.sol"), sol);
  execFileSync("forge", ["build", "--root", dir], { stdio: "inherit" });
  const artifact = JSON.parse(await readFile(join(dir, "out", "SignalLog.sol", "SignalLog.json"), "utf8"));

  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(config.baseSepoliaRpcUrl) });
  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object as `0x${string}`,
    args: [account.address],
  });
  console.log(`deploy tx: ${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log(`SignalLog deployed at: ${receipt.contractAddress}`);
  console.log(`set SIGNAL_LOG_ADDRESS=${receipt.contractAddress} in .env`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
