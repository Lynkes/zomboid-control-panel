// Contract between server/routes/bridgeDelivery.js and the client.
// Mirrors client/src/lib/bridgeDeliveryTypes.ts: same names, same values, same order.
// Change only by a coordinated edit of both files (bridgeDeliveryContractParity.test.js
// fails when they drift).
export const DELIVERY_METHODS = Object.freeze(["local", "workshop"]);
export const DELIVERY_STATES = Object.freeze([
  "local-ok", "local-update-pending", "local-not-installed", "local-unverified", "local-workshop-loaded",
  "workshop-restart-needed", "workshop-waiting", "workshop-confirmed", "workshop-not-loaded",
  "workshop-stopped", "workshop-start-failed", "workshop-id-unknown",
]);
export const DELIVERY_BLOCK_REASONS = Object.freeze([
  "sameMethod", "notPublished", "idInvalid", "noSteam", "gameVersionUnsupported", "iniNotFound", "iniDuplicateKeys",
]);
export const DELIVERY_WARNINGS = Object.freeze([
  "serverRunning", "customLauncher", "sharedInstall", "gameVersionUnknown", "previewItem", "envOverride",
  "siblingIniMissing", "unrecognizedLooseFile", "checksumWillBeTurnedOff",
]);
export const CHECKSUM_BLOCKERS = Object.freeze(["notWorkshop", "notConfirmed", "looseFilesPresent", "alreadyOn"]);
export const LOOSE_FILE_KINDS = Object.freeze(["server", "client", "rootModInfo"]);
export const BRIDGE_MOD_ID = "ZomboidControlPanelBridge";
