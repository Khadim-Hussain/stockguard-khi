import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { MongoDBSessionStorage } from "@shopify/shopify-app-session-storage-mongodb";
import prisma from "./db.js";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new MongoDBSessionStorage(
    new URL(process.env.DATABASE_URL),
    "stockguard",
    { sessionCollectionName: "sessions" }
  ),
  distribution: AppDistribution.AppStore,
  future: { expiringOfflineAccessTokens: true },
});

export { prisma };
export default shopify;

export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = (...args) => shopify.addDocumentResponseHeaders(...args);
export const authenticate = {
  admin: (...args) => shopify.authenticate.admin(...args),
  public: (...args) => shopify.authenticate.public(...args),
  webhook: (...args) => shopify.authenticate.webhook(...args),
};
export const login = (...args) => shopify.login(...args);
