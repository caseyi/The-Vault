import { cardImages, detailImage, withThumbWidth, isMeshPreview, formatBytes } from './thumbs';

describe('thumbs helpers', () => {
  test('cardImages prefers thumb_urls, then thumb_url, then originals', () => {
    expect(cardImages({ thumb_url: '/thumbs/u/a.png?w=480&v=1', thumb_urls: ['/thumbs/u/a.png?w=480&v=1', '/thumbs/u/b.png?w=480&v=2'], images: ['/images/u/a.png'] }))
      .toEqual(['/thumbs/u/a.png?w=480&v=1', '/thumbs/u/b.png?w=480&v=2']);
    expect(cardImages({ thumb_url: '/thumbs/u/a.png?w=480&v=1', images: ['/images/u/a.png', '/images/u/b.png'] }))
      .toEqual(['/thumbs/u/a.png?w=480&v=1']);
    // older backend: no thumb fields at all
    expect(cardImages({ images: ['/images/u/a.png', '/images/u/b.png'], thumbnail_path: '/images/u/a.png' }))
      .toEqual(['/images/u/a.png', '/images/u/b.png']);
    expect(cardImages({ images: [], thumbnail_path: '/images/u/t.png' })).toEqual(['/images/u/t.png']);
    expect(cardImages({ thumb_url: null, thumb_urls: [], images: [], thumbnail_path: null })).toEqual([]);
  });

  test('cardImages puts thumb_url first when thumb_urls does not include it', () => {
    expect(cardImages({ thumb_url: '/thumbs/u/t.png?w=480', thumb_urls: ['/thumbs/u/a.png?w=480'] }))
      .toEqual(['/thumbs/u/t.png?w=480', '/thumbs/u/a.png?w=480']);
  });

  test('withThumbWidth swaps only /thumbs/ widths', () => {
    expect(withThumbWidth('/thumbs/u/a.png?w=1280&v=9', 480)).toBe('/thumbs/u/a.png?w=480&v=9');
    expect(withThumbWidth('/thumbs/u/a.png?v=9', 480)).toBe('/thumbs/u/a.png?v=9&w=480');
    expect(withThumbWidth('/images/u/a.png', 480)).toBe('/images/u/a.png');
  });

  test('detailImage uses aligned thumb_urls and falls back to the original', () => {
    const m = { images: ['/images/u/a.png', '/images/u/b.png'], thumb_urls: ['/thumbs/u/a.png?w=1280&v=1', null] };
    expect(detailImage(m, 0)).toBe('/thumbs/u/a.png?w=1280&v=1');
    expect(detailImage(m, 0, 480)).toBe('/thumbs/u/a.png?w=480&v=1');
    expect(detailImage(m, 1)).toBe('/images/u/b.png');
    expect(detailImage({ images: ['/images/u/a.png'] }, 0)).toBe('/images/u/a.png');
  });

  test('isMeshPreview and formatBytes', () => {
    expect(isMeshPreview({ thumb_source: 'stl' })).toBe(true);
    expect(isMeshPreview({ thumb_source: 'archive' })).toBe(false);
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(81234567)).toBe('77 MB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });
});
