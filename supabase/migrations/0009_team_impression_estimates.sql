-- Brooklyn Nets and Memphis Grizzlies are augmentation partners but were seeded
-- with placeholder impression_rank=1 / impression_estimate=0 (non-partner defaults).
-- That zeroes out impressions and game_cost whenever they are the aug side.

update teams
set impression_rank = 18, impression_estimate = 35000
where full_name = 'Brooklyn Nets';

update teams
set impression_rank = 15, impression_estimate = 12000
where full_name = 'Memphis Grizzlies';
