UPDATE "transactions"
SET "category" = CASE "category"
  WHEN 'food' THEN 'dining_food_delivery'
  WHEN 'transit' THEN 'transport'
  WHEN 'utility' THEN 'utilities'
  WHEN 'subs' THEN 'subscriptions'
  WHEN 'transfer' THEN 'peer_to_peer_transfer'
  WHEN 'fun' THEN 'entertainment_leisure'
  WHEN 'health' THEN 'healthcare'
  WHEN 'other' THEN 'uncategorized'
  ELSE "category"
END,
"original_category" = CASE "original_category"
  WHEN 'food' THEN 'dining_food_delivery'
  WHEN 'transit' THEN 'transport'
  WHEN 'utility' THEN 'utilities'
  WHEN 'subs' THEN 'subscriptions'
  WHEN 'transfer' THEN 'peer_to_peer_transfer'
  WHEN 'fun' THEN 'entertainment_leisure'
  WHEN 'health' THEN 'healthcare'
  WHEN 'other' THEN 'uncategorized'
  ELSE "original_category"
END,
"updated_at" = now();

UPDATE "budgets"
SET "category" = CASE "category"
  WHEN 'food' THEN 'dining_food_delivery'
  WHEN 'transit' THEN 'transport'
  WHEN 'utility' THEN 'utilities'
  WHEN 'subs' THEN 'subscriptions'
  WHEN 'transfer' THEN 'peer_to_peer_transfer'
  WHEN 'fun' THEN 'entertainment_leisure'
  WHEN 'health' THEN 'healthcare'
  WHEN 'other' THEN 'uncategorized'
  ELSE "category"
END,
"updated_at" = now();

