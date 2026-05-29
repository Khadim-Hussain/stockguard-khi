import { useLoaderData, useFetcher } from "react-router";
import { useState, useCallback } from "react";
import {
  Page, Card, ResourceList, ResourceItem, Text, Thumbnail,
  BlockStack, TextField, Button, Banner, Badge, InlineStack,
  EmptyState, Box, Divider, DataTable, Icon, Layout, Modal,
  FormLayout, Select, Tabs, Spinner, ButtonGroup, Checkbox,
} from "@shopify/polaris";
import {
  EmailIcon, ProductIcon, ClockIcon, EditIcon, PersonIcon,
} from "@shopify/polaris-icons";
import shopify from "../shopify.server.js";
import { sendProductEmail } from "../email.server.js";
import prisma from "../db.server.js";

export const loader = async ({ request }) => {
  try {
    const { admin, session } = await shopify.authenticate.admin(request);
    const shop = session.shop;

    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor") || null;

    // Parallel fetch with individual error handling to prevent timeouts
    const [pRes, cRes, lRes, history] = await Promise.all([
      admin.graphql(`
        query GetProducts($cursor: String) {
          products(first: 50, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id title description featuredImage { url }
              variants(first: 20) {
                nodes { id title price inventoryQuantity inventoryItem { id } }
              }
            }
          }
        }
      `, { variables: { cursor } }).then(r => r.json()).catch(() => ({ data: null })),
      
      admin.graphql(`
        query {
          customers(first: 100) {
            nodes { id displayName email }
          }
        }
      `).then(r => r.json()).catch(e => ({ data: null, error: e.message })),

      admin.graphql(`
        query {
          locations(first: 10) {
            nodes { id name isActive }
          }
        }
      `).then(r => r.json()).catch(() => ({ data: null })),

      prisma.emailHistory.findMany({
        where: { shop },
        orderBy: { sentAt: "desc" },
        take: 50,
      }).catch(() => [])
    ]);

    const pData = pRes?.data;
    const cData = cRes?.data;
    const lData = lRes?.data;
    const customerError = cRes?.errors?.[0]?.message || cRes?.error || null;

    const products = pData?.products?.nodes?.map((p) => {
      const variants = p.variants.nodes.map((v) => ({
        id: v.id, title: v.title, price: v.price, stock: v.inventoryQuantity, inventoryItemId: v.inventoryItem?.id,
      }));
      const totalStock = variants.reduce((sum, v) => sum + (v.stock || 0), 0);
      return {
        id: p.id, title: p.title, description: p.description, image: p.featuredImage?.url || null,
        variants: variants, price: variants[0]?.price || null, stock: totalStock,
        hasOutOfStockVariants: variants.some(v => v.stock === 0),
      };
    }) || [];

    const customers = cData?.customers?.nodes
      ?.filter((c) => c.email)
      ?.map((c) => ({ id: c.id, name: c.displayName, email: c.email })) || [];

    const pageInfo = pData?.products?.pageInfo || { hasNextPage: false, endCursor: null };
    const locations = lData?.locations?.nodes?.filter(l => l.isActive)?.map(l => ({
      label: l.name, value: l.id
    })) || [];

    return { products, customers, history, shop, pageInfo, locations, customerError };
  } catch (error) {
    console.error("Critical Loader error:", error);
    return { products: [], customers: [], history: [], shop: "", pageInfo: { hasNextPage: false, endCursor: null }, locations: [], error: error.message };
  }
};

export const action = async ({ request }) => {
  const { admin, session } = await shopify.authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  // Update stock
  if (intent === "update_stock") {
    const quantity = parseInt(formData.get("quantity") || "0");
    const inventoryItemId = formData.get("inventoryItemId");
    const locationId = formData.get("locationId");

    if (!locationId) return { error: "Please select a location." };

    const mutationRes = await admin.graphql(`
      mutation SetInventory($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) {
          userErrors { field message }
        }
      }
    `, {
      variables: {
        input: {
          name: "available",
          quantities: [{ inventoryItemId, locationId, quantity }],
          reason: "correction",
        },
      },
    });

    const mutData = await mutationRes.json();
    const userErrors = mutData.data?.inventorySetQuantities?.userErrors;

    if (userErrors?.length > 0) {
      return { error: userErrors[0].message };
    }

    return { success: true, intent: "stock_updated" };
  }

  // Send email
  if (intent === "send_email") {
    const productData = JSON.parse(formData.get("products") || "[]");
    const emails = formData.get("emails")
      ?.split(",")
      .map((e) => e.trim())
      .filter((e) => e.includes("@")) || [];

    if (!emails.length) return { error: "Please enter at least one valid email." };
    if (!productData.length) return { error: "No products selected." };

    try {
      // Re-fetch product data from Shopify for security and up-to-date info
      const productIds = productData.map(p => p.id);
      
      const productsRes = await admin.graphql(`
        query GetProducts($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
              title
              description
              featuredImage { url }
              variants(first: 1) {
                nodes { price }
              }
            }
          }
        }
      `, {
        variables: { ids: productIds }
      });

      const { data: { nodes: verifiedProducts } } = await productsRes.json();
      
      const formattedProducts = verifiedProducts.filter(Boolean).map(p => ({
        id: p.id,
        title: p.title,
        description: p.description,
        image: p.featuredImage?.url,
        price: p.variants.nodes[0]?.price
      }));

      await Promise.all(
        formattedProducts.map((product) => sendProductEmail({ recipients: emails, product }))
      );

      await Promise.all(
        formattedProducts.map((product) =>
          prisma.emailHistory.create({
            data: {
              shop,
              productId: product.id,
              productTitle: product.title,
              productImage: product.image,
              productPrice: product.price,
              recipients: emails,
              status: "sent",
            },
          })
        )
      );

      return { success: true, count: emails.length, products: formattedProducts.length, intent: "email_sent" };
    } catch (err) {
      console.error("Email send error:", err);
      return { error: "Failed to send: " + err.message };
    }
  }

  return { error: "Unknown action" };
};

export default function Index() {
  const { products, customers, history, pageInfo, locations, error: loaderError, customerError } = useLoaderData();
  const fetcher = useFetcher();

  const [selectedTab, setSelectedTab] = useState(0);
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [emails, setEmails] = useState("");
  const [manualEmail, setManualEmail] = useState("");
  const [selectedCustomers, setSelectedCustomers] = useState([]);
  const [search, setSearch] = useState("");
  const [editModal, setEditModal] = useState(null);
  const [newStock, setNewStock] = useState("");
  const [selectedLocation, setSelectedLocation] = useState(locations[0]?.value || "");

  const isSending = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "send_email";
  const isUpdating = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "update_stock";
  const result = fetcher.data;

  const filtered = products.filter((p) =>
    p.title.toLowerCase().includes(search.toLowerCase())
  );

  const outOfStock = products.filter((p) => p.hasOutOfStockVariants || p.stock === 0);

  function toggleProduct(product) {
    setSelectedProducts((prev) =>
      prev.find((p) => p.id === product.id)
        ? prev.filter((p) => p.id !== product.id)
        : [...prev, product]
    );
  }

  function toggleCustomer(customer) {
    setSelectedCustomers((prev) =>
      prev.find((c) => c.id === customer.id)
        ? prev.filter((c) => c.id !== customer.id)
        : [...prev, customer]
    );
  }

  function getAllEmails() {
    const customerEmails = selectedCustomers.map((c) => c.email);
    const manual = emails.split(",").map((e) => e.trim()).filter((e) => e.includes("@"));
    return [...new Set([...customerEmails, ...manual])];
  }

  function handleSend() {
    if (!selectedProducts.length) return;
    const allEmails = getAllEmails();
    if (!allEmails.length) return;
    const form = new FormData();
    form.append("intent", "send_email");
    form.append("products", JSON.stringify(selectedProducts));
    form.append("emails", allEmails.join(","));
    fetcher.submit(form, { method: "post" });
  }

  // Effect to clear selection on success
  if (result?.success && result?.intent === "email_sent" && fetcher.state === "idle" && selectedProducts.length > 0) {
    setSelectedProducts([]);
    setSelectedCustomers([]);
    setEmails("");
  }

  function handleUpdateStock() {
    if (!selectedLocation) return;
    const form = new FormData();
    form.append("intent", "update_stock");
    form.append("variantId", editModal.variantId);
    form.append("inventoryItemId", editModal.inventoryItemId);
    form.append("locationId", selectedLocation);
    form.append("quantity", newStock);
    fetcher.submit(form, { method: "post" });
    setEditModal(null);
    setNewStock("");
  }

  const tabs = [
    { id: "products", content: `Products (${products.length})` },
    { id: "out-of-stock", content: `Out of Stock (${outOfStock.length})` },
    { id: "history", content: `Email History (${history.length})` },
  ];

  const historyRows = history.map((h) => [
    <InlineStack gap="200" blockAlign="center">
      {h.productImage && <Thumbnail source={h.productImage} alt={h.productTitle} size="small" />}
      <Text variant="bodySm" fontWeight="bold">{h.productTitle}</Text>
    </InlineStack>,
    <Text variant="bodySm">{h.recipients.join(", ")}</Text>,
    <Badge tone={h.status === "sent" ? "success" : "critical"}>
      {h.status === "sent" ? "✓ Sent" : "✗ Failed"}
    </Badge>,
    <Text variant="bodySm" tone="subdued">
      {new Date(h.sentAt).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
    </Text>,
  ]);

  return (
    <Page title="" subtitle="">
      {loaderError && (
        <Banner tone="critical" title="App Refresh Required" marginBlockEnd="400">
          <p>There was an error loading your data: {loaderError}. Please refresh the page.</p>
        </Banner>
      )}

      {customerError && (
        <Banner tone="warning" title="Customer Section Limited" marginBlockEnd="400">
          <p>We couldn't load your customers: <strong>{customerError}</strong>. This is usually due to missing permissions. You can still manage products, but the email campaign tool will be limited.</p>
        </Banner>
      )}

      {/* App Header */}
      <Box background="bg-surface" padding="400" borderRadius="300" borderWidth="025" borderColor="border" marginBlockEnd="500">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="400" blockAlign="center">
            <Box width="60px" height="60px">
              <img src="/icon.svg" alt="StockGuard" style={{ width: 60, height: 60, borderRadius: 12 }} />
            </Box>
            <BlockStack gap="050">
              <Text variant="heading2xl" fontWeight="bold">StockGuard</Text>
              <Text tone="subdued" variant="bodyMd">Product Marketing & Inventory Management</Text>
              <InlineStack gap="200">
                <Badge tone="success">● Active</Badge>
                <Badge tone="info">v1.0.0</Badge>
              </InlineStack>
            </BlockStack>
          </InlineStack>
          <InlineStack gap="300">
            <Box background="bg-surface-secondary" padding="300" borderRadius="200">
              <BlockStack gap="050" inlineAlign="center">
                <Text variant="heading2xl" fontWeight="bold" tone="success">{products.length}</Text>
                <Text variant="bodySm" tone="subdued">Products</Text>
              </BlockStack>
            </Box>
            <Box background="bg-surface-secondary" padding="300" borderRadius="200">
              <BlockStack gap="050" inlineAlign="center">
                <Text variant="heading2xl" fontWeight="bold" tone="critical">{outOfStock.length}</Text>
                <Text variant="bodySm" tone="subdued">Out of Stock</Text>
              </BlockStack>
            </Box>
            <Box background="bg-surface-secondary" padding="300" borderRadius="200">
              <BlockStack gap="050" inlineAlign="center">
                <Text variant="heading2xl" fontWeight="bold">{history.length}</Text>
                <Text variant="bodySm" tone="subdued">Emails Sent</Text>
              </BlockStack>
            </Box>
            <Box background="bg-surface-secondary" padding="300" borderRadius="200">
              <BlockStack gap="050" inlineAlign="center">
                <Text variant="heading2xl" fontWeight="bold">{customers.length}</Text>
                <Text variant="bodySm" tone="subdued">Customers</Text>
              </BlockStack>
            </Box>
          </InlineStack>
        </InlineStack>
      </Box>

      {/* Stock Edit Modal */}
      <Modal
        open={!!editModal}
        onClose={() => setEditModal(null)}
        title={`Update Stock — ${editModal?.productTitle}`}
        primaryAction={{ content: "Update Stock", onAction: handleUpdateStock, loading: isUpdating }}
        secondaryActions={[{ content: "Cancel", onAction: () => setEditModal(null) }]}
      >
        <Modal.Section>
          <FormLayout>
            <Text tone="subdued">Variant: {editModal?.variantTitle}</Text>
            <Text tone="subdued">Current Stock Total: <Badge tone="critical">{editModal?.currentStock}</Badge></Text>
            <Select
              label="Select Location"
              options={locations}
              value={selectedLocation}
              onChange={setSelectedLocation}
            />
            <TextField
              label="New Stock Quantity at Location"
              type="number"
              value={newStock}
              onChange={setNewStock}
              min="0"
              autoComplete="off"
              autoFocus
            />
          </FormLayout>
        </Modal.Section>
      </Modal>

      <Layout>
        {/* Left — Send Email Panel */}
        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="400">
                <InlineStack gap="200" blockAlign="center">
                  <Icon source={EmailIcon} tone="base" />
                  <Text variant="headingMd" fontWeight="bold">Send Campaign</Text>
                </InlineStack>
                <Divider />

                {result?.success && result?.intent === "email_sent" && (
                  <Banner tone="success" title={`✅ Sent to ${result.count} recipient(s) for ${result.products} product(s)!`} onDismiss={() => {}} />
                )}
                {result?.error && <Banner tone="critical" title={result.error} onDismiss={() => {}} />}
                {result?.intent === "stock_updated" && (
                  <Banner tone="success" title="✅ Stock updated successfully!" onDismiss={() => {}} />
                )}

                {/* Selected Products */}
                <BlockStack gap="200">
                  <Text variant="headingSm">Selected Products ({selectedProducts.length})</Text>
                  {selectedProducts.length === 0 ? (
                    <Box background="bg-surface-secondary" padding="300" borderRadius="200">
                      <Text tone="subdued" alignment="center">Select products from the list →</Text>
                    </Box>
                  ) : (
                    <BlockStack gap="200">
                      {selectedProducts.map((p) => (
                        <Box key={p.id} background="bg-surface-secondary" padding="200" borderRadius="200">
                          <InlineStack align="space-between" blockAlign="center">
                            <InlineStack gap="200" blockAlign="center">
                              {p.image && <Thumbnail source={p.image} alt={p.title} size="small" />}
                              <Text variant="bodySm" fontWeight="bold">{p.title}</Text>
                            </InlineStack>
                            <Button size="micro" tone="critical" onClick={() => toggleProduct(p)}>✕</Button>
                          </InlineStack>
                        </Box>
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>

                <Divider />

                {/* Store Customers */}
                <BlockStack gap="200">
                  <InlineStack gap="200" blockAlign="center">
                    <Icon source={PersonIcon} tone="base" />
                    <Text variant="headingSm">Store Customers ({customers.length})</Text>
                  </InlineStack>
                  {customers.length === 0 ? (
                    <Text tone="subdued" variant="bodySm">No customers found in store.</Text>
                  ) : (
                    <Box maxHeight="200px" overflowY="auto" accessibilityLabel="Customer list">
                      <BlockStack gap="100">
                        {customers.map((c) => (
                          <Box key={c.id} padding="150" background={selectedCustomers.find((s) => s.id === c.id) ? "bg-surface-selected" : "bg-surface"} borderRadius="100">
                            <InlineStack align="space-between" blockAlign="center">
                              <BlockStack gap="0">
                                <Text variant="bodySm" fontWeight="semibold">{c.name}</Text>
                                <Text variant="bodySm" tone="subdued">{c.email}</Text>
                              </BlockStack>
                              <Checkbox
                                label=""
                                checked={!!selectedCustomers.find((s) => s.id === c.id)}
                                onChange={() => toggleCustomer(c)}
                              />
                            </InlineStack>
                          </Box>
                        ))}
                      </BlockStack>
                    </Box>
                  )}
                </BlockStack>

                <Divider />

                {/* Manual Emails */}
                <TextField
                  label="Add Email Addresses Manually"
                  value={emails}
                  onChange={setEmails}
                  placeholder="email1@gmail.com, email2@gmail.com"
                  helpText="Comma-separated — adds to selected customers"
                  autoComplete="off"
                  multiline={2}
                />

                {getAllEmails().length > 0 && (
                  <Box background="bg-surface-secondary" padding="200" borderRadius="200">
                    <Text variant="bodySm" tone="subdued">
                      Total recipients: <strong>{getAllEmails().length}</strong>
                    </Text>
                  </Box>
                )}

                <Button
                  variant="primary"
                  size="large"
                  onClick={handleSend}
                  disabled={!selectedProducts.length || !getAllEmails().length || isSending}
                  loading={isSending}
                  fullWidth
                >
                  🚀 Send Email Campaign
                </Button>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        {/* Right — Products & History */}
        <Layout.Section>
          <Card padding="0">
            <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
              <Box padding="400">

                {/* All Products Tab */}
                {selectedTab === 0 && (
                  <BlockStack gap="300">
                    <TextField
                      placeholder="🔍 Search products..."
                      value={search}
                      onChange={setSearch}
                      autoComplete="off"
                      clearButton
                      onClearButtonClick={() => setSearch("")}
                    />
                    {filtered.length === 0 ? (
                      <EmptyState heading="No products found" image="">
                        <p>Try a different search term.</p>
                      </EmptyState>
                    ) : (
                      <ResourceList
                        resourceName={{ singular: "product", plural: "products" }}
                        items={filtered}
                        renderItem={(product) => {
                          const isSelected = !!selectedProducts.find((p) => p.id === product.id);
                          return (
                            <ResourceItem id={product.id} onClick={() => toggleProduct(product)}>
                              <Box background={isSelected ? "bg-surface-selected" : undefined} borderRadius="200">
                                <InlineStack align="space-between" blockAlign="center">
                                  <InlineStack gap="300" blockAlign="center">
                                    <Thumbnail source={product.image || ""} alt={product.title} size="medium" />
                                    <BlockStack gap="100">
                                      <Text variant="bodyMd" fontWeight="bold">{product.title}</Text>
                                      <Text tone="success" fontWeight="semibold">${product.price}</Text>
                                    </BlockStack>
                                  </InlineStack>
                                  <InlineStack gap="200" blockAlign="center">
                                    <Badge tone={product.stock === 0 ? "critical" : product.stock <= 10 ? "warning" : "success"}>
                                      {product.stock === 0 ? "Out of stock" : `${product.stock} in stock`}
                                    </Badge>
                                    {isSelected && <Badge tone="info">✓ Selected</Badge>}
                                  </InlineStack>
                                </InlineStack>
                              </Box>
                            </ResourceItem>
                          );
                        }}
                      />
                    )}
                    {pageInfo.hasNextPage && (
                      <Box paddingBlockStart="400">
                        <InlineStack align="center">
                          <Button 
                            onClick={() => {
                              const url = new URL(window.location);
                              url.searchParams.set("cursor", pageInfo.endCursor);
                              window.location.href = url.toString();
                            }}
                          >
                            Load More Products
                          </Button>
                        </InlineStack>
                      </Box>
                    )}
                  </BlockStack>
                )}

                {/* Out of Stock Tab */}
                {selectedTab === 1 && (
                  <BlockStack gap="300">
                    {outOfStock.length === 0 ? (
                      <EmptyState heading="🎉 No out of stock products!" image="">
                        <p>All your products have inventory.</p>
                      </EmptyState>
                    ) : (
                      <ResourceList
                        resourceName={{ singular: "product", plural: "products" }}
                        items={outOfStock}
                        renderItem={(product) => (
                          <ResourceItem id={product.id} onClick={() => {}}>
                            <InlineStack align="space-between" blockAlign="center">
                              <InlineStack gap="300" blockAlign="center">
                                <Thumbnail source={product.image || ""} alt={product.title} size="medium" />
                                <BlockStack gap="100">
                                  <Text variant="bodyMd" fontWeight="bold">{product.title}</Text>
                                  <Text tone="success">${product.price}</Text>
                                </BlockStack>
                              </InlineStack>
                              <InlineStack gap="200">
                                <Badge tone="critical">Out of Stock</Badge>
                                <ButtonGroup>
                                  {product.variants.map((v) => (
                                    <Button
                                      key={v.id}
                                      size="slim"
                                      icon={EditIcon}
                                      tone={v.stock === 0 ? "critical" : undefined}
                                      onClick={() => setEditModal({
                                        productTitle: product.title,
                                        variantId: v.id,
                                        variantTitle: v.title,
                                        inventoryItemId: v.inventoryItemId,
                                        currentStock: v.stock,
                                      })}
                                    >
                                      {product.variants.length > 1 ? `${v.title}: ${v.stock}` : "Edit Stock"}
                                    </Button>
                                  ))}
                                </ButtonGroup>
                              </InlineStack>
                            </InlineStack>
                          </ResourceItem>
                        )}
                      />
                    )}
                  </BlockStack>
                )}

                {/* History Tab */}
                {selectedTab === 2 && (
                  history.length === 0 ? (
                    <EmptyState heading="No emails sent yet" image="">
                      <p>Your email campaign history will appear here.</p>
                    </EmptyState>
                  ) : (
                    <DataTable
                      columnContentTypes={["text", "text", "text", "text"]}
                      headings={["Product", "Recipients", "Status", "Sent At"]}
                      rows={historyRows}
                      hoverable
                    />
                  )
                )}

              </Box>
            </Tabs>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
