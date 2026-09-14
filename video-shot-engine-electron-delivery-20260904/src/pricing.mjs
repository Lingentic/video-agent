export const XINHANKR_PRICING = { currency: "CNY", inputPerMillion: 1.5, outputPerMillion: 7.5 };

export function calculateCostYuan(usage) {
  const input = Number(usage?.total_input_tokens || 0);
  const output = Number(usage?.total_output_tokens || 0);
  return Number(((input * XINHANKR_PRICING.inputPerMillion + output * XINHANKR_PRICING.outputPerMillion) / 1_000_000).toFixed(6));
}
