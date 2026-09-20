import type {Capability} from '../core/contracts.js';

// Data-only capability: control-plane imports must not initialize a browser driver.
export const FIXTURE_DRAFT:Capability={id:'fixture.draft.save',effect:'write_external',route:'playwright.fixture.draft.v1',environments:['owned_headless'],hiddenVerified:false,requiresForeground:false,requiresOsInput:false,usesUserTarget:false,requiresClipboard:false,requiresFileDialog:false,verification:'independent_readback'};
