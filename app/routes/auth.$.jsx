import { authenticate } from "../shopify.js";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};
