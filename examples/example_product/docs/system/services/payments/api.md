# Payments API

REST over HTTPS, base path `/payments/v1`. Called only by other services, with service-to-service tokens; apps never call it directly.

## POST /authorizations

Reserves the order total on the customer's card. Called by orders when an order is placed.

### Request

| Field | Type | Required | Description |
|---|---|---|---|
| orderId | uuid | yes | Order being paid; also the idempotency key. |
| amount | money | yes | Total from pricing. Payments never recalculates it. |
| paymentMethodId | string | yes | Saved card token from the payment provider. |

### Response

| Field | Type | Description |
|---|---|---|
| authorizationId | uuid | Id to capture or release later. |
| status | enum | AUTHORIZED, REQUIRES_ACTION or DECLINED. |
| actionUrl | url | 3-D Secure page when status is REQUIRES_ACTION. |

### Errors

| Status | Code | When |
|---|---|---|
| 409 | already_authorized | An authorisation already exists for this order with a different amount. |
| 422 | invalid_payment_method | The card token is unknown or expired. |

## POST /authorizations/{id}/capture

Takes the reserved money. Called by orders when the order is delivered.

### Response

| Field | Type | Description |
|---|---|---|
| captureId | uuid | Id of the captured payment. |
| capturedAmount | money | Amount taken; never more than authorised. |

### Errors

| Status | Code | When |
|---|---|---|
| 404 | not_found | No authorisation with this id. |
| 409 | not_capturable | The authorisation was released or already captured. |
