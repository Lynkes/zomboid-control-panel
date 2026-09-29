import { BRIDGE_MOD_ID } from "../../services/bridgeDeliveryContract.js";

// Tests must never read the repository's live pz-mod/workshop/published.json:
// once the maintainer records the real Workshop item id there, every "not
// published yet" case would silently start testing a published release.
// Stubbing the exe build's embedded document (PANEL_BRIDGE_WORKSHOP_JSON)
// pins the base release to "not published"; a test that needs a published
// id still sets PANEL_BRIDGE_WORKSHOP_ID on top of it, exactly as before.
export const UNPUBLISHED_WORKSHOP_RELEASE = JSON.stringify({
  schema: 1,
  modId: BRIDGE_MOD_ID,
  workshopId: null,
  visibility: null,
  publishedVersion: null,
  publishedAt: null,
  liveVerified: { windowsServer: null, linuxServer: null },
});
