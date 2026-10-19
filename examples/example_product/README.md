# Example product

Spec tree for **Forkly**, a food delivery marketplace, in the format from [node-types](../../docs/method/node-types/rules.md).

```
example_product/
├─ .uspec/node-types/   16 node types
└─ docs/                the spec tree
   ├─ product/          by user problem    6 areas, 15 features, glossary
   ├─ experience/       by app             5 apps, 24 screens, design system, messaging
   └─ system/           by service         11 services, domain model, architecture, platform
```

72 nodes in total. The tree passes every [validation check](../../docs/method/node-types/rules.md).

## Filled-in documents

Most documents are empty files. These are written out as samples:

| Document | Shows |
|---|---|
| [overview.md](docs/overview.md) | root: vision, users, scope, constraints |
| [product/ordering/checkout/user-story.md](docs/product/ordering/checkout/user-story.md) | a user story with acceptance criteria |
| [product/glossary/terms.md](docs/product/glossary/terms.md) | the glossary |
| [system/domain-model/lifecycle.md](docs/system/domain-model/lifecycle.md) | the order state machine |
| [system/services/payments/api.md](docs/system/services/payments/api.md) | a service API, with [api-extra/openapi.yaml](docs/system/services/payments/api-extra/openapi.yaml) |
| [experience/customer-app/cart-and-checkout/states.md](docs/experience/customer-app/cart-and-checkout/states.md) | screen states and transitions |
