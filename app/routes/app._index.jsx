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

// We use standard imports now that we removed the .server suffix to stop Vite's overly aggressive scanner
import shopify, { authenticate } from "../shopify.js";
import { sendProductEmail } from "../email.js";
import prisma from "../db.js";

export const loader = async ({ request }) => {
  try {
    const { admin, session } = await authenticate.admin(request);
    const shop = session.shop;

    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor") || null;

    const [pRes, cRes, lRes, history] = await Promise.all([
      admin.graphql(`#graphql
        query getProducts($cursor: String) {
          products(first: 10, after: $cursor) {
            edges {
              node {
                id
                title
                handle
                featuredImage { url altText }
                variants(first: 10) {
                  edges {
                    node {
                      id title sku inventoryQuantity
                      price 
                    }
                  }
                }
              }
              cursor
            }
            pageInfo { hasNextPage }
          }
        }`, { variables: { cursor } }),
      admin.graphql(`#graphql
        query getCustomers {
          customers(first: 50) {
            edges {
              node { id displayName email }
            }
          }
        }`).catch(e => {
          console.error("Customer fetch failed:", e);
          return { data: { customers: { edges: [] } }, errors: [{ message: e.message }] };
        }),
      admin.graphql(`#graphql
        query getLocations {
          locations(first: 1) {
            edges { node { id name } }
          }
        }`),
      prisma.emailHistory.findMany({
        where: { shop },
        orderBy: { sentAt: "desc" },
        take: 10
      })
    ]);

    const productsData = pRes.data?.products?.edges || [];
    const hasNextPage = pRes.data?.products?.pageInfo?.hasNextPage || false;
    const endCursor = productsData.length > 0 ? productsData[productsData.length - 1].cursor : null;
    
    const customers = cRes.data?.customers?.edges?.map(e => e.node) || [];
    const customerError = cRes.errors ? cRes.errors[0].message : null;
    
    const locationId = lRes.data?.locations?.edges[0]?.node?.id || "";

    return { 
      products: productsData, 
      customers, 
      customerError,
      locationId,
      emailHistory: history,
      hasNextPage,
      endCursor
    };
  } catch (error) {
    console.error("Loader error:", error);
    return { 
      error: error.message,
      products: [], 
      customers: [], 
      emailHistory: [],
      hasNextPage: false 
    };
  }
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "updateStock") {
    const variantId = formData.get("variantId");
    const delta = parseInt(formData.get("delta"), 10);
    const locationId = formData.get("locationId");

    const response = await admin.graphql(`#graphql
      mutation inventoryAdjust($input: InventoryAdjustQuantityInput!) {
        inventoryAdjustQuantity(input: $input) {
          inventoryLevel { id available }
          userErrors { field message }
        }
      }`, {
      variables: {
        input: {
          inventoryItemId: variantId.replace("gid://shopify/ProductVariant/", "gid://shopify/InventoryItem/"),
          locationId: locationId,
          availableDelta: delta
        }
      }
    });
    return { success: !response.data.inventoryAdjustQuantity.userErrors.length };
  }

  if (intent === "sendEmail") {
    const productTitle = formData.get("productTitle");
    const productId = formData.get("productId");
    const recipients = JSON.parse(formData.get("recipients"));
    const productImage = formData.get("productImage");
    const productPrice = formData.get("productPrice");

    try {
      await sendProductEmail({
        recipients,
        productTitle,
        productImage,
        productPrice,
        shop
      });

      await prisma.emailHistory.create({
        data: {
          shop,
          productId,
          productTitle,
          productImage,
          productPrice,
          recipients,
          status: "sent"
        }
      });

      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  return null;
};

export default function Index() {
  const { 
    products = [], 
    customers = [], 
    customerError, 
    locationId, 
    emailHistory = [], 
    error,
    hasNextPage,
    endCursor
  } = useLoaderData();
  
  const fetcher = useFetcher();
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedVariants, setSelectedVariants] = useState([]);
  const [selectedRecipients, setSelectedRecipients] = useState([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState(0);

  const tabs = [
    { id: 'inventory', content: 'Inventory', accessibilityLabel: 'Inventory management' },
    { id: 'history', content: 'Campaign History', accessibilityLabel: 'Email sent history' },
  ];

  const handleTabChange = useCallback((selectedTabIndex) => setActiveTab(selectedTabIndex), []);

  const handleUpdateStock = (variantId, delta) => {
    fetcher.submit(
      { intent: "updateStock", variantId, delta, locationId },
      { method: "post" }
    );
  };

  const openEmailModal = (product) => {
    setSelectedProduct(product);
    setSelectedVariants(product.node.variants.edges.map(e => e.node));
    setIsModalOpen(true);
  };

  const handleSendEmail = () => {
    if (selectedRecipients.length === 0) return;
    
    fetcher.submit({
      intent: "sendEmail",
      productId: selectedProduct.node.id,
      productTitle: selectedProduct.node.title,
      productImage: selectedProduct.node.featuredImage?.url || "",
      productPrice: selectedProduct.node.variants.edges[0]?.node?.price || "0",
      recipients: JSON.stringify(selectedRecipients)
    }, { method: "post" });
    
    setIsModalOpen(false);
    setSelectedRecipients([]);
  };

  if (error) {
    return (
      <Page title="Dashboard">
        <Banner status="critical">
          <p>Critical Error: {error}. Please check your connection or app permissions.</p>
        </Banner>
      </Page>
    );
  }

  return (
    <Page title="StockGuard Dashboard">
      {customerError && (
        <Box paddingBlockEnd="400">
          <Banner status="warning" title="Customer Section Limited">
            <p>We couldn't load customer data: {customerError}. Other features remain active.</p>
          </Banner>
        </Box>
      )}

      <Layout>
        <Layout.Section>
          <Card padding="0">
            <Tabs tabs={tabs} selected={activeTab} onSelect={handleTabChange}>
              <Box padding="400">
                {activeTab === 0 ? (
                  <BlockStack gap="400">
                    <Text variant="headingMd" as="h2">Manage Inventory</Text>
                    <ResourceList
                      resourceName={{ singular: 'product', plural: 'products' }}
                      items={products}
                      renderItem={(item) => {
                        const { id, title, featuredImage, variants } = item.node;
                        const media = (
                          <Thumbnail source={featuredImage?.url || ProductIcon} alt={title} />
                        );

                        return (
                          <ResourceItem id={id} media={media} accessibilityLabel={`View details for ${title}`}>
                            <BlockStack gap="300">
                              <Text variant="bodyMd" fontWeight="bold">{title}</Text>
                              <Box padding="200" background="bg-surface-secondary" borderRadius="200">
                                <DataTable
                                  columnContentTypes={['text', 'numeric', 'text']}
                                  headings={['Variant', 'Stock', 'Actions']}
                                  rows={variants.edges.map(v => [
                                    v.node.title,
                                    <Badge key={v.node.id} status={v.node.inventoryQuantity <= 5 ? 'warning' : 'success'}>
                                      {v.node.inventoryQuantity} in stock
                                    </Badge>,
                                    <ButtonGroup key={`${v.node.id}-actions`}>
                                      <Button onClick={() => handleUpdateStock(v.node.id, 1)}>+1</Button>
                                      <Button onClick={() => handleUpdateStock(v.node.id, -1)}>-1</Button>
                                    </ButtonGroup>
                                  ])}
                                />
                              </Box>
                              <InlineStack align="end">
                                <Button icon={EmailIcon} onClick={() => openEmailModal(item)}>Notify Customers</Button>
                              </InlineStack>
                            </BlockStack>
                          </ResourceItem>
                        );
                      }}
                    />
                    {hasNextPage && (
                      <InlineStack align="center">
                        <Button onClick={() => window.location.search = `?cursor=${endCursor}`}>Load More Products</Button>
                      </InlineStack>
                    )}
                  </BlockStack>
                ) : (
                  <BlockStack gap="400">
                    <Text variant="headingMd" as="h2">Sent Email Campaigns</Text>
                    {emailHistory.length === 0 ? (
                      <EmptyState heading="No campaigns yet" image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png">
                        <p>Track your stock notification emails here.</p>
                      </EmptyState>
                    ) : (
                      <ResourceList
                        resourceName={{ singular: 'log', plural: 'logs' }}
                        items={emailHistory}
                        renderItem={(item) => (
                          <ResourceItem id={item.id} media={<Icon source={ClockIcon} />}>
                            <InlineStack align="space-between">
                              <BlockStack>
                                <Text variant="bodyMd" fontWeight="bold">{item.productTitle}</Text>
                                <Text variant="bodySm" color="subdued">Sent to {item.recipients.length} customers</Text>
                              </BlockStack>
                              <Text variant="bodySm">{new Date(item.sentAt).toLocaleDateString()}</Text>
                            </InlineStack>
                          </ResourceItem>
                        )}
                      />
                    )}
                  </BlockStack>
                )}
              </Box>
            </Tabs>
          </Card>
        </Layout.Section>
      </Layout>

      <Modal
        open={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={`Send stock update: ${selectedProduct?.node.title}`}
        primaryAction={{
          content: 'Send Email',
          onAction: handleSendEmail,
          disabled: selectedRecipients.length === 0,
          loading: fetcher.state === "submitting"
        }}
      >
        <Modal.Section>
          <BlockStack gap="400">
          <Box accessibilityLabel="Recipients list scroll box">
            <Text variant="bodyMd" as="p">Select customers to notify about {selectedProduct?.node.title} inventory.</Text>
            <Box paddingBlockStart="300">
              <TextField
                label="Recipients Emails"
                value={selectedRecipients.join(', ')}
                multiline={3}
                helpText="Choose from the list below or type emails separated by comma"
                onChange={(val) => setSelectedRecipients(val.split(',').map(e => e.trim()))}
                autoComplete="off"
              />
            </Box>
          </Box>
            <Divider />
            <Box paddingBlockStart="200" accessibilityLabel="Customer selection scroll box">
              <Text variant="bodyMd" fontWeight="bold">Customer Database</Text>
              <ResourceList
                resourceName={{ singular: 'customer', plural: 'customers' }}
                items={customers}
                renderItem={(customer) => (
                  <ResourceItem id={customer.id} media={<Icon source={PersonIcon} />}>
                    <Checkbox
                      label={`${customer.displayName} (${customer.email})`}
                      checked={selectedRecipients.includes(customer.email)}
                      onChange={(checked) => {
                        if (checked) setSelectedRecipients([...selectedRecipients, customer.email]);
                        else setSelectedRecipients(selectedRecipients.filter(e => e !== customer.email));
                      }}
                    />
                  </ResourceItem>
                )}
              />
            </Box>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
