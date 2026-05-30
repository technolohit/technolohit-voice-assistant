export function createProductState() {
  return {
    overviewOffered: false,
    awaitingSelection: false,
    awaitingInterestConfirmation: true,
    selectedProduct: null,
    selectedProductName: null,
    productDialogueState: "idle",
    handoffChoice: "none",
    botintegFollowupResolved: false,
    botintegFollowupRetryCount: 0,
    customerType: null,
    salesNeedCaptured: false,
    salesContext: {},
    repair: null,
    lastProductIntent: null,
    lastProductTurnIndex: null
  };
}
