import { authenticate } from "../shopify.js";

export const action = async ({ request }) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  switch (topic) {
    case "APP_UNINSTALLED":
      console.log(`App uninstalled from ${payload.shop}`);
      break;
    default:
      return new Response("Unhandled webhook topic", { status: 404 });
  }

  return new Response("OK");
};
