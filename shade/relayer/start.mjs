// Runs the 0xbow relayer, but bound to localhost (the ShadePool UI server proxies /relayer).
const port = Number(process.env.SHADE_RELAYER_PORT || 8921);
const { app } = await import("../../packages/relayer/dist/app.js");
const { db } = await import("../../packages/relayer/dist/providers/db.provider.js");
const { quoteService } = await import("../../packages/relayer/dist/services/index.js");
// ZeroPrint design: the relayer pays the gas and charges only the configured fee_bps. Stock 0xbow
// adds gasPrice*650k/amount on top, which at 0.001 ETH and >=0.008 gwei exceeds the pool's 0.5 % max
// relay fee, so small withdrawals revert with RelayFeeGreaterThanMax. Quote and validation both use this.
quoteService.netFeeBPSNative = async (baseFee) => baseFee;
await db.init();
app.listen(port, "127.0.0.1", () => console.log(`shadepool relayer on 127.0.0.1:${port}`));
