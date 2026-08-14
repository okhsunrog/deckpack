import { enumeratePackPlans } from "../domain/packing";
import type { EnumerationRequest } from "../domain/types";

self.onmessage = (event: MessageEvent<EnumerationRequest & { requestId?: number }>) => {
  self.postMessage({ ...enumeratePackPlans(event.data), requestId: event.data.requestId });
};
