# Forkly

Forkly is a food delivery marketplace: customers order from local restaurants, couriers deliver, and Forkly takes a commission on each order.

## Users

- Customers order food on the mobile app or the website.
- Restaurants manage their menu and accept orders in the partner dashboard.
- Couriers pick up and deliver orders using the courier app.
- The ops team handles refunds, promotions and courier issues in the ops console.

## Scope

- Browsing and searching restaurants, ordering, paying by card.
- Delivery by Forkly couriers, with live tracking.
- Weekly payouts to restaurants.

## Out of scope

- Restaurants' own delivery staff.
- Cash payments.
- Grocery and non-food retail.

## Constraints

- Card data never touches Forkly servers outside the payments service (PCI scope).
- Customer data is stored in the EU.
