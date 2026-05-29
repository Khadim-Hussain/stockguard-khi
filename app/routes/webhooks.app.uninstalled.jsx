import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";

export const action = async ({ request }) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and build up in the queue.
  // Records should be deleted in a way that is idempotent.
  switch (topic) {
    case "APP_UNINSTALLED":
      if (payload.shop) {
        // Clear sessions or specific data if needed. 
        // MongoDB sessions are managed by MongoDBSessionStorage internally if configured correctly,
        // but extra cleanup can go here.
        console.log(`App uninstalled from ${payload.shop}`);
      }
      break;
    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
    case "SHOP_REDACT":
    default:
      throw new Response("Unhandled webhook topic", { status: 404 });
  }

  throw new Response();
};
