---
description: |
  The service's contract: every endpoint (REST) or operation (GraphQL)
  other services and apps call. This is the document screens are built
  against; changing it affects every node that derives from this service.
  Put machine-readable schemas (OpenAPI, GraphQL SDL) in api-extra/.
extra: true
---

# <Service> API

<Style (REST or GraphQL), base path, authentication.>

## <operation>

<What it does and who calls it.>

### Request

| Field | Type | Required | Description |
|---|---|---|---|
| <field> | <type> | <yes/no> | <meaning> |

### Response

| Field | Type | Description |
|---|---|---|
| <field> | <type> | <meaning> |

### Errors

| Status | Code | When |
|---|---|---|
| <HTTP status> | <error code> | <condition> |
