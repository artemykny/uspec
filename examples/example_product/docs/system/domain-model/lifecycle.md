# Lifecycles

## Order

### States

| State | Meaning |
|---|---|
| PENDING | Created, payment not yet authorised. |
| PLACED | Payment authorised; waiting for the restaurant. |
| ACCEPTED | Restaurant is preparing the food. |
| ASSIGNED | A courier has taken the job. |
| PICKED_UP | The courier has the food. |
| DELIVERED | Handed to the customer; payment captured. |
| CANCELLED | Stopped before delivery; authorisation released. |
| FAILED | Payment was declined. |

### Transitions

| From | Event | To |
|---|---|---|
| PENDING | payment authorised | PLACED |
| PENDING | payment declined | FAILED |
| PLACED | restaurant accepts | ACCEPTED |
| PLACED | no acceptance within 5 minutes | CANCELLED |
| ACCEPTED | courier accepts job | ASSIGNED |
| ASSIGNED | courier picks up | PICKED_UP |
| PICKED_UP | courier confirms delivery | DELIVERED |
