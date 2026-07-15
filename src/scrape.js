import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const getPrices = async (page) => {
  const oldText = await page.locator('#prices-old').textContent().catch(() => null);
  const newText = await page.locator('#prices-new').textContent().catch(() => null);
  const parsePrice = (t) => t ? parseFloat(t.replace(/[^0-9.]/g, '')) || null : null;
  const parsedOld = parsePrice(oldText);
  const parsedNew = parsePrice(newText);

  let price = parsedNew || parsedOld || null;
  let sale_price = null;
  if (parsedOld && parsedNew) {
    price = parsedOld;
    sale_price = parsedNew;
  }

  return { price, sale_price };
}

const getRating = async (page) => {
  // appears later
  await page.waitForFunction(() => {
    const el = document.querySelector('#average-rating-info') || document.querySelector('#description-list-average-rating');
    return el && el.textContent.trim().length > 0;
  }, { timeout: 5000 }).catch(() => {});

  const ratingText = await page.evaluate(() => {
    const el = document.querySelector('#average-rating-info') || document.querySelector('#description-list-average-rating');
    return el ? el.textContent : '';
  }).catch(() => '');

  const ratingMatch = ratingText.match(/([\d.]+)\s*\((\d+)\)/);
  const star_rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;
  const review_count = ratingMatch ? parseInt(ratingMatch[2], 10) : null;

  return {
    star_rating,
    review_count,
  }
}

const getAvailability = async (page) => {
  const availText = (await page.locator('#prices-wrapper').textContent().catch(() => '')).toLowerCase();
  if (availText.includes('in stock')) return 'in_stock';
  else if (availText.includes('out of stock')) return 'out_of_stock';
  else if (availText.includes('pre-order') || availText.includes('pre order')) return 'pre_order';

  return null;
}

const getBasicInfo = async (page) => {
  try {
    const titleLocator = page.locator('h2.title').first();
    await titleLocator.waitFor({ state: 'visible', timeout: 5000 });

    const title = (await titleLocator.textContent().catch(() => ''))?.trim() || null;
    const item_id = await page.locator('input[name="product_id"]').getAttribute('value').catch(() => null);

    const descriptionText = await page.locator('h2.title + div p').first().textContent().catch(() => null);
    const description = descriptionText ? descriptionText.trim() : null;

    const prices = await getPrices(page);
    const availability = await getAvailability(page);
    const rating = await getRating(page);

    return {
      item_id,
      title,
      description,
      ...prices,
      availability,
      ...rating,
      brand: 'MSI',
    };
  } catch (error) {
    console.warn('Basic info extraction error:', error.message);
    return {
      item_id: null,
      title: null,
      description: null,
      price: null,
      sale_price: null,
      availability: null,
      star_rating: null,
      review_count: null,
      brand: null,
    };
  }
}

// breadcrumbs
const getNavigation = async (page) => {
  try {
    const breadcrumbs = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.breadcrumb li, ul.breadcrumb li'));
      return items.map(item => {
        const link = item.querySelector('a');
        return {
          name: item.textContent.replace(/[>/]/g, '').trim(),
          url: link ? link.href : null
        };
      }).filter(item => item.name);
    }).catch(() => []);

    const cleanTree = breadcrumbs.filter(b => b.name.toLowerCase() !== 'home');
    const product_category = cleanTree.map(b => b.name).join(' > ') || null;

    return {
      product_category,
      category_tree: cleanTree,
    };
  } catch (error) {
    console.warn('Navigation extraction error:', error.message);
    return { product_category: null, category_tree: [] };
  }
}

// images
const getMedia = async (page) => {
  try {
    const mainImg = await page.locator('#imagePopup').getAttribute('src').catch(() => null);

    const additionalImgs = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('.product-detail-thumb-bto'));
      const urls = imgs.map(img => img.getAttribute('popup_img')).filter(Boolean);
      return [...new Set(urls)];
    }).catch(() => []);

    const filteredAdditionals = additionalImgs.filter(url => url !== mainImg);

    return {
      image_url: mainImg,
      additional_image_urls: filteredAdditionals
    };
  } catch (error) {
    console.warn('Media extraction error:', error.message);
    return { image_url: null, additional_image_urls: [] };
  }
}

const getSpecs = async (page) => {
  try {
    return page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.table-borderless tbody tr'));
      return rows.map(row => {
        const nameEl = row.querySelector('th');
        const valueEl = row.querySelector('td');
        return {
          name: nameEl ? nameEl.textContent.trim() : null,
          value: valueEl ? valueEl.textContent.trim() : null
        };
      }).filter(item => item.name);
    }).catch(() => []);
  } catch (error) {
    console.warn('Specs extraction error:', error.message);
    return [];
  }
}

const getIdentifiers = (specs) => {
  const mpnSpec = specs.find(s => s.name?.toLowerCase().includes('manufacturer number'));
  const mpn = mpnSpec ? mpnSpec.value : null;

  return {
    mpn,
    gtin: null,
  };
}

const extractProductData = async (page) => {
  console.log('Extracting data...');

  const basicInfo = await getBasicInfo(page);
  const navInfo = await getNavigation(page);
  const media = await getMedia(page);
  const specs = await getSpecs(page);
  const identifiers = getIdentifiers(specs);

  return {
    url: page.url(),
    item_id: basicInfo.item_id,
    title: basicInfo.title,
    brand: basicInfo.brand,
    product_category: navInfo.product_category,
    category_tree: navInfo.category_tree,
    description: basicInfo.description,
    price: basicInfo.price,
    sale_price: basicInfo.sale_price,
    availability: basicInfo.availability,
    image_url: media.image_url,
    additional_image_urls: media.additional_image_urls,
    specs: specs,
    star_rating: basicInfo.star_rating,
    review_count: basicInfo.review_count,
    gtin: identifiers.gtin,
    mpn: identifiers.mpn,
    scraped_at: new Date().toISOString()
  };
}

async function main() {
  let browser;
  try {
    console.log('Launching browser...');
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    const url = 'https://us-store.msi.com/Motherboards/Intel-Platform-Motherboard/INTEL-Z890/MAG-Z890-TOMAHAWK-WIFI';
    console.log(`Navigating to: ${url}`);
    await page.goto(url, { waitUntil: 'load' });

    const productData = await extractProductData(page);

    const outputDir = path.join(process.cwd(), 'output');
    const outputPath = path.join(outputDir, 'product.json');

    await fs.mkdir(outputDir, { recursive: true });

    await fs.writeFile(outputPath, JSON.stringify(productData, null, 2), 'utf-8');
    console.log(`Successfully saved product data to ${outputPath}`);

  } catch (error) {
    console.error('Scraper failed:', error);
  } finally {
    if (browser) {
      // await browser.close();
      console.log('Browser left open for debugging.');
    }
  }
}

main();