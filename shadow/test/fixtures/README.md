# Zerion fixtures

Synthetic JSON:API responses, not recordings: ZERION_API_KEY was not available in the Phase 2C-a session.
Field names follow the official client in zerion-cli 1.9.1 (github.com/zeriontech/zerion-ai): `data[].id`,
`attributes.external_id`, `attributes.name` for chains; `attributes.hash`, `mined_at`, `status`,
`operation_type`, `fee`, `transfers` for transactions; `relationships.chain.data.id`; `links.next` for paging.
`sent_from`, `sent_to`, and `mined_at_block` are assumed from the Zerion API and are not relied on: the
locator re-reads sender, target, block, and timestamp on chain. Replace these files with recorded
responses (key redacted) after the first live run.

The chain catalog lists only Ethereum and Base, so nothing here implies whether Zerion supports Monad.
