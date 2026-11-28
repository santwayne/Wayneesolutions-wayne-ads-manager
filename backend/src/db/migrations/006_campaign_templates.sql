-- All Meta campaign templates: post boost and catalog ads have no uploaded image/video.
ALTER TABLE creatives DROP CONSTRAINT IF EXISTS creatives_type_check;
ALTER TABLE creatives ADD CONSTRAINT creatives_type_check CHECK (type IN ('image', 'video', 'post', 'catalog'));
