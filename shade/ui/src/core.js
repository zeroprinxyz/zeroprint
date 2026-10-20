// ZeroPrint core: everything secret happens here, in the user's browser (or the E2E script).
// Nothing in this file sends the Zero Key, nullifiers or secrets anywhere.
import {
  AccountService,
  Circuits,
  DataService,
  PrivacyPoolSDK,
  calculateContext,
  generateMasterKeys,
} from "@0xbow/privacy-pools-core-sdk";
import { LeanIMT } from "@zk-kit/lean-imt";
import { poseidon } from "maci-crypto/build/ts/hashing.js";
import { createPublicClient, defineChain, encodeFunctionData, http, parseAbi, parseAbiItem } from "viem";

export const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

// The SDK's internal viem client caches eth_blockNumber for ~4s; reloading history sooner
// than that after a tx misses the tx. Call this between a confirmed tx and loadAccount().
export const settle = () => new Promise((r) => setTimeout(r, 4500));

const ENTRYPOINT_ABI = parseAbi([
  "function deposit(uint256 _precommitment) payable returns (uint256)",
  "function latestRoot() view returns (uint256)",
  "function assetConfig(address) view returns (address pool, uint256 minimumDepositAmount, uint256 vettingFeeBPS, uint256 maxRelayFeeBPS)",
]);
const POOL_ABI = parseAbi([
  "function ragequit((uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256[4] pubSignals) _proof)",
  "function withdraw((address processooor, bytes data) _withdrawal, (uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256[8] pubSignals) _proof)",
  "function currentRoot() view returns (uint256)",
  "function currentTreeSize() view returns (uint256)",
]);
const EV_DEPOSITED = parseAbiItem(
  "event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash)",
);
const EV_WITHDRAWN = parseAbiItem(
  "event Withdrawn(address indexed _processooor, uint256 _value, uint256 _spentNullifier, uint256 _newCommitment)",
);

// ZeroPrintASP: the association set as a contract (see packages/contracts/src/zeroprint)
const ASP_ABI = parseAbi([
  "event Queued(uint256 indexed _label, address indexed _depositor, uint256 _at)",
  "event Denied(uint256 indexed _label, string _reason)",
  "event Approved(uint256 indexed _label, uint256 _index)",
  "function WINDOW() view returns (uint256)",
  "function queueMany(uint256[] _labels)",
  "function approve(uint256[] _labels) returns (uint256)",
]);
const POOL_DEPOSITORS_ABI = parseAbi(["function depositors(uint256) view returns (address)"]);

const hash2 = (a, b) => poseidon([a, b]);
const hex = (n) => "0x" + BigInt(n).toString(16);

function formatProof(p) {
  return {
    pA: [hex(p.proof.pi_a[0]), hex(p.proof.pi_a[1])],
    pB: [
      [hex(p.proof.pi_b[0][1]), hex(p.proof.pi_b[0][0])],
      [hex(p.proof.pi_b[1][1]), hex(p.proof.pi_b[1][0])],
    ],
    pC: [hex(p.proof.pi_c[0]), hex(p.proof.pi_c[1])],
    pubSignals: p.publicSignals.map(hex),
  };
}

// LeanIMT gives index NaN for a single-leaf tree; the circuit wants 0 and 32 siblings
function circuitProof(p) {
  return {
    ...p,
    index: Number.isNaN(p.index) ? 0 : p.index,
    siblings: [...p.siblings, ...Array(Math.max(0, 32 - p.siblings.length)).fill(0n)],
  };
}

/**
 * @param cfg {
 *   rpcUrl, deployment: {chainId, entrypoint, pool, scope, startBlock},
 *   aspUrl, relayerUrl, circuits?: {browser, baseUrl}, logChunk?
 * }
 */
export function createShade(cfg) {
  const d = cfg.deployment;
  const chain = defineChain({
    id: d.chainId,
    name: cfg.chainName ?? `chain-${d.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  const scope = BigInt(d.scope);
  const poolInfo = { chainId: d.chainId, address: d.pool, scope, deploymentBlock: BigInt(d.startBlock) };
  const dataService = new DataService([
    { chainId: d.chainId, privacyPoolAddress: d.pool, startBlock: BigInt(d.startBlock), rpcUrl: cfg.rpcUrl },
  ]);
  let sdk;
  const getSdk = () => (sdk ??= new PrivacyPoolSDK(new Circuits(cfg.circuits ?? {})));

  /** Logs of one contract since the deployment, in chunks; a chunk the node refuses is split. */
  async function getLogsChunked(event, address = d.pool) {
    const head = await pub.getBlockNumber();
    let step = BigInt(cfg.logChunk ?? 500_000);
    const out = [];
    for (let from = BigInt(d.startBlock); from <= head; ) {
      const to = from + step - 1n > head ? head : from + step - 1n;
      try {
        out.push(...(await pub.getLogs({ address, event, fromBlock: from, toBlock: to })));
        from = to + 1n;
      } catch (e) {
        if (step <= 2_000n) throw e;
        step /= 4n;
      }
    }
    return out;
  }

  const onchainAsp = !!d.asp;
  let aspWindow;
  const windowOf = async () => (aspWindow ??= await pub.readContract({ address: d.asp, abi: ASP_ABI, functionName: "WINDOW" }));

  /** All state-tree leaves in insertion order (deposits + withdrawal change notes). */
  async function stateLeaves() {
    const [deps, wds] = await Promise.all([getLogsChunked(EV_DEPOSITED), getLogsChunked(EV_WITHDRAWN)]);
    return [
      ...deps.map((l) => ({ b: l.blockNumber, i: l.logIndex, leaf: l.args._commitment })),
      ...wds.map((l) => ({ b: l.blockNumber, i: l.logIndex, leaf: l.args._newCommitment })),
    ]
      .sort((x, y) => (x.b === y.b ? x.i - y.i : x.b < y.b ? -1 : 1))
      .map((x) => x.leaf);
  }

  /** Association set, checked against the on-chain root (never trust an API blindly). */
  async function aspSet() {
    let labels;
    if (onchainAsp) {
      // ZeroPrintASP: the set is its Approved events, in index order. No server involved.
      const logs = await getLogsChunked(ASP_ABI[2], d.asp);
      labels = logs.sort((a, b) => (a.args._index < b.args._index ? -1 : 1)).map((l) => l.args._label);
    } else {
      const r = await fetch(`${cfg.aspUrl}/set`, { cache: "no-store" });
      if (!r.ok) throw new Error(`ASP unreachable (${r.status})`);
      labels = (await r.json()).labels.map(BigInt);
    }
    const onchain = await pub.readContract({ address: d.entrypoint, abi: ENTRYPOINT_ABI, functionName: "latestRoot" }).catch(() => 0n);
    if (!labels.length) return { labels, root: 0n, onchain };
    const tree = new LeanIMT(hash2);
    tree.insertMany(labels);
    if (tree.root !== onchain) throw new Error("ASP set does not match the on-chain root yet, try again in a minute");
    return { labels, root: tree.root, onchain, tree };
  }

  /** Pending and denied deposits. Read whole (events or the API) so nobody learns which one is yours. */
  async function aspStatus() {
    if (onchainAsp) {
      const [queued, denied, window] = await Promise.all([getLogsChunked(ASP_ABI[0], d.asp), getLogsChunked(ASP_ABI[1], d.asp), windowOf()]);
      return {
        queued: new Set(queued.map((l) => l.args._label.toString())),
        pending: new Map(queued.map((l) => [l.args._label.toString(), Number(l.args._at + window)])),
        denied: new Map(denied.map((l) => [l.args._label.toString(), l.args._reason])),
      };
    }
    const [pending, denied] = await Promise.all(
      ["pending", "denied"].map((p) => fetch(`${cfg.aspUrl}/${p}`, { cache: "no-store" }).then((r) => r.json())),
    );
    return {
      queued: null,
      pending: new Map(pending.map((x) => [x.label, x.eta])),
      denied: new Map(denied.map((x) => [x.label, x.reason])),
    };
  }

  /**
   * ZeroPrintASP only: the transaction that queues or approves your deposits, for when no keeper
   * does it. Send it from the wallet that made the deposits (never from a fresh wallet: that would
   * link the two). Returns null when there is nothing to do.
   */
  async function aspActionTx(list, from) {
    if (!onchainAsp) return null;
    const mine = [];
    for (const n of list) {
      const who = await pub.readContract({ address: d.pool, abi: POOL_DEPOSITORS_ABI, functionName: "depositors", args: [BigInt(n.label)] });
      if (who.toLowerCase() === from.toLowerCase()) mine.push(n);
    }
    const now = Number((await pub.getBlock()).timestamp); // the contract judges by chain time
    const toQueue = mine.filter((n) => n.state === "unqueued").map((n) => BigInt(n.label));
    const toApprove = mine.filter((n) => n.state === "pending" && n.eta && n.eta <= now).map((n) => BigInt(n.label));
    if (toApprove.length) return { kind: "approve", count: toApprove.length, to: d.asp, value: 0n, data: encodeFunctionData({ abi: ASP_ABI, functionName: "approve", args: [toApprove] }) };
    if (toQueue.length) return { kind: "queue", count: toQueue.length, to: d.asp, value: 0n, data: encodeFunctionData({ abi: ASP_ABI, functionName: "queueMany", args: [toQueue] }) };
    return null;
  }

  /** Rebuild the account from the Zero Key by scanning the chain. */
  async function loadAccount(mnemonic) {
    generateMasterKeys(mnemonic); // throws on a bad phrase
    const acct = new AccountService(dataService, { mnemonic });
    await acct.retrieveHistory([poolInfo]);
    return acct;
  }

  /**
   * Notes for the UI. Each pool account = one deposit; its spendable note is the
   * latest child (after partial withdrawals) or the deposit itself.
   */
  async function notes(acct) {
    const [set, status] = await Promise.all([aspSet().catch(() => ({ labels: [] })), aspStatus().catch(() => null)]);
    const approved = new Set(set.labels.map(String));
    return (acct.account.poolAccounts.get(scope) ?? []).map((pa) => {
      const latest = pa.children.length ? pa.children[pa.children.length - 1] : pa.deposit;
      const label = pa.label.toString();
      let state = "pending";
      if (pa.ragequit) state = "ragequit";
      else if (latest.value === 0n) state = "spent";
      else if (approved.has(label)) state = "approved";
      else if (status?.denied.has(label)) state = "denied";
      else if (status?.queued && !status.queued.has(label)) state = "unqueued";
      return {
        label,
        deposited: pa.deposit.value,
        balance: pa.ragequit ? 0n : latest.value,
        state,
        reason: status?.denied.get(label),
        eta: status?.pending.get(label),
        depositTx: pa.deposit.txHash,
        depositBlock: pa.deposit.blockNumber,
        withdrawals: pa.children.length,
        commitment: latest,
      };
    });
  }

  async function poolConfig() {
    const [pool, minimumDepositAmount, vettingFeeBPS, maxRelayFeeBPS] = await pub.readContract({
      address: d.entrypoint,
      abi: ENTRYPOINT_ABI,
      functionName: "assetConfig",
      args: [NATIVE],
    });
    return { pool, minimumDepositAmount, vettingFeeBPS, maxRelayFeeBPS };
  }

  /** Builds the deposit tx; the wallet signs it. Secrets come from the Zero Key + next index. */
  function depositTx(acct, value) {
    const { precommitment } = acct.createDepositSecrets(scope);
    return {
      to: d.entrypoint,
      value,
      data: encodeFunctionData({ abi: ENTRYPOINT_ABI, functionName: "deposit", args: [precommitment] }),
    };
  }

  async function quote(amount, recipient) {
    const r = await fetch(`${cfg.relayerUrl}/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chainId: d.chainId, amount: amount.toString(), asset: NATIVE, recipient }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.message || j.error || `relayer quote failed (${r.status})`);
    return j;
  }

  /** Proof for spending `amount` of `note` under `withdrawal` (made locally; nothing leaves). */
  async function proveSpend(acct, note, amount, withdrawal, onStep) {
    const context = BigInt(calculateContext(withdrawal, scope));
    onStep("trees");
    const [leaves, set] = await Promise.all([stateLeaves(), aspSet()]);
    const stateTree = new LeanIMT(hash2);
    stateTree.insertMany(leaves);
    const commitment = note.commitment;
    const si = stateTree.indexOf(commitment.hash);
    if (si < 0) throw new Error("Your note is not in the pool tree yet");
    const ai = set.tree?.indexOf(commitment.label) ?? -1;
    if (ai < 0) throw new Error("This deposit is not approved by the ASP (yet)");
    const sp = stateTree.generateProof(si);
    const ap = set.tree.generateProof(ai);
    const { nullifier, secret } = acct.createWithdrawalSecrets(commitment);
    onStep("prove");
    return getSdk().proveWithdrawal(commitment, {
      context,
      withdrawalAmount: amount,
      stateMerkleProof: circuitProof(sp),
      aspMerkleProof: circuitProof(ap),
      stateRoot: stateTree.root,
      stateTreeDepth: BigInt(stateTree.depth),
      aspRoot: set.tree.root,
      aspTreeDepth: BigInt(set.tree.depth),
      newSecret: secret,
      newNullifier: nullifier,
    });
  }

  /**
   * Private withdrawal through the relayer. The proof is made locally; the relayer only
   * sees the proof, the amount and the recipient.
   */
  async function withdraw(acct, note, amount, recipient, onStep = () => {}) {
    onStep("quote");
    const q = await quote(amount, recipient);
    const fc = q.feeCommitment;
    const withdrawal = { processooor: d.entrypoint, data: fc.withdrawalData };
    const proof = await proveSpend(acct, note, amount, withdrawal, onStep);
    onStep("relay");
    const r = await fetch(`${cfg.relayerUrl}/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        withdrawal,
        publicSignals: proof.publicSignals.map(String),
        proof: proof.proof,
        scope: scope.toString(),
        chainId: d.chainId,
        feeCommitment: { ...fc, amount: fc.amount.toString() },
      }),
    });
    const j = await r.json();
    if (!r.ok || j.success === false) throw new Error(j.error || j.message || `relayer rejected (${r.status})`);
    return { txHash: j.txHash, feeBPS: BigInt(q.feeBPS), quote: q };
  }

  /**
   * Withdrawal without any relayer: `account` sends the transaction, pays the gas and receives
   * the ETH. Use a fresh wallet funded by something unlinked, or it links back.
   */
  async function withdrawDirectTx(acct, note, amount, account, onStep = () => {}) {
    const withdrawal = { processooor: account, data: "0x" };
    const proof = await proveSpend(acct, note, amount, withdrawal, onStep);
    return {
      to: d.pool,
      value: 0n,
      data: encodeFunctionData({ abi: POOL_ABI, functionName: "withdraw", args: [withdrawal, formatProof(proof)] }),
    };
  }

  /** Ragequit: public exit back to the original depositor. Returns the tx for the wallet. */
  async function ragequitTx(note) {
    const c = note.commitment;
    const proof = await getSdk().proveCommitment(c.value, c.label, c.nullifier, c.secret);
    return {
      to: d.pool,
      value: 0n,
      data: encodeFunctionData({ abi: POOL_ABI, functionName: "ragequit", args: [formatProof(proof)] }),
    };
  }

  async function anonymitySet() {
    const s = await fetch(`${cfg.aspUrl}/stats`, { cache: "no-store" }).then((r) => r.json());
    return s;
  }

  return {
    chain,
    pub,
    scope,
    poolInfo,
    onchainAsp,
    loadAccount,
    notes,
    poolConfig,
    depositTx,
    quote,
    withdraw,
    withdrawDirectTx,
    ragequitTx,
    aspSet,
    aspStatus,
    aspActionTx,
    anonymitySet,
    stateLeaves,
  };
}
