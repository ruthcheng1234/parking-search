const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const retry = require('async-retry');
const winston = require('winston');

const app = express();

// 連接 MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/carpark_db', {
    useNewUrlParser: true,
    useUnifiedTopology: true
});

// 定義停車場數據模型
const CarparkSchema = new mongoose.Schema({
    data: Array,
    lastUpdated: { type: Date, default: Date.now }
});
const CarparkModel = mongoose.model('Carpark', CarparkSchema);

// 設置請求限制
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15分鐘
    max: 100, // 每個 IP 限制 100 次請求
    message: '請求次數過多，請稍後再試'
});

app.use(cors());
app.use(express.json());
app.use('/api/', limiter);
app.use(express.static('public'));

// 添加日誌記錄
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' })
    ]
});

// 計算兩點之間的距離（公里）
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // 地球半徑（公里）
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
        Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// 添加數據驗證函數
function validateCarpark(carpark) {
    return (
        carpark.name &&
        carpark.latitude &&
        carpark.longitude &&
        !isNaN(carpark.latitude) &&
        !isNaN(carpark.longitude) &&
        carpark.latitude >= -90 &&
        carpark.latitude <= 90 &&
        carpark.longitude >= -180 &&
        carpark.longitude <= 180
    );
}

// 修改 scrapeWithRetry 函數，添加自定義請求頭
async function scrapeWithRetry(url) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-HK,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
    };

    return retry(
        async (bail) => {
            try {
                const response = await axios.get(url, { headers });
                return response.data;
            } catch (error) {
                logger.error(`抓取錯誤: ${url}`, { error: error.message });
                if (error.response && error.response.status === 404) {
                    bail(error);
                    return;
                }
                throw error;
            }
        },
        {
            retries: 3,
            minTimeout: 2000,
            maxTimeout: 5000,
            onRetry: (error, attempt) => {
                logger.warn(`重試第 ${attempt} 次: ${url}`, { error: error.message });
            }
        }
    );
}

async function scrapeCarparks() {
    try {
        // 檢查緩存
        const cachedData = await CarparkModel.findOne().sort({ lastUpdated: -1 });
        if (cachedData && Date.now() - cachedData.lastUpdated < 3600000) {
            return cachedData.data;
        }

        // 使用代理池（如果需要）
        const proxyList = [
            'http://proxy1.example.com',
            'http://proxy2.example.com'
        ];

        const [hk01Data, kilowattData] = await Promise.all([
            scrapeWithRetry('https://hk01data.github.io/carpark/'),
            scrapeWithRetry('https://www.kilowatt.hk/chargers/')
        ]);

        const $ = cheerio.load(hk01Data);
        const $k = cheerio.load(kilowattData);

        const carparks = [];
        
        // 解析 HK01 停車場數據
        $('.carpark-item').each((i, elem) => {
            try {
                const name = $(elem).find('.carpark-name').text().trim();
                const address = $(elem).find('.carpark-address').text().trim();
                const capacity = parseInt($(elem).find('.carpark-capacity').text()) || 0;
                const latitude = parseFloat($(elem).attr('data-lat'));
                const longitude = parseFloat($(elem).attr('data-lng'));
                
                // 解析路旁泊車位信息
                const streetParking = {
                    total: 0,
                    available: 0,
                    fee: ''
                };

                // 尋找相關的路旁泊車位信息
                const streetParkingInfo = $(elem).find('.street-parking-info');
                if (streetParkingInfo.length > 0) {
                    streetParking.total = parseInt(streetParkingInfo.find('.total-spaces').text()) || 0;
                    streetParking.available = parseInt(streetParkingInfo.find('.available-spaces').text()) || 0;
                    streetParking.fee = streetParkingInfo.find('.parking-fee').text().trim();
                }
                
                // 添加更多停車場信息
                const additionalInfo = {
                    openingHours: $(elem).find('.opening-hours').text().trim() || '24小時',
                    contactNumber: $(elem).find('.contact').text().trim() || '未提供',
                    facilities: $(elem).find('.facilities').map((_, el) => $(el).text().trim()).get(),
                    lastUpdated: new Date().toISOString()
                };

                const carparkData = {
                    name,
                    address,
                    capacity,
                    latitude,
                    longitude,
                    nearbyBuildings: [],
                    chargingStations: 0,
                    chargingProvider: '',
                    chargingType: '',
                    streetParking: {
                        total: streetParking.total,
                        available: streetParking.available,
                        fee: streetParking.fee
                    },
                    ...additionalInfo
                };

                if (validateCarpark(carparkData)) {
                    carparks.push(carparkData);
                } else {
                    logger.warn('無效的停車場數據', { data: carparkData });
                }
            } catch (error) {
                logger.error('解析停車場數據錯誤', { error: error.message, element: $(elem).html() });
            }
        });

        // 解析路旁泊車位區域數據
        $('.street-parking-zone').each((i, elem) => {
            const zoneName = $(elem).find('.zone-name').text().trim();
            const zoneAddress = $(elem).find('.zone-address').text().trim();
            const totalSpaces = parseInt($(elem).find('.total-spaces').text()) || 0;
            const latitude = parseFloat($(elem).attr('data-lat'));
            const longitude = parseFloat($(elem).attr('data-lng'));
            const parkingFee = $(elem).find('.parking-fee').text().trim();

            carparks.push({
                name: `路旁泊車區 - ${zoneName}`,
                address: zoneAddress,
                capacity: totalSpaces,
                latitude,
                longitude,
                nearbyBuildings: [],
                chargingStations: 0,
                chargingProvider: '',
                chargingType: '',
                isStreetParking: true,
                streetParking: {
                    total: totalSpaces,
                    available: totalSpaces, // 實際可用數可能需要從其他 API 獲取
                    fee: parkingFee
                }
            });
        });

        // 解析 Kilowatt 充電站數據
        const chargerMap = new Map(); // 用於存儲每個位置的充電站信息

        $('.charger-location').each((i, elem) => {
            const location = $(elem).find('.location-name').text().trim();
            const providers = $(elem).find('.provider').map((_, el) => $(el).text().trim()).get();
            const types = $(elem).find('.charger-type').map((_, el) => $(el).text().trim()).get();
            const count = $(elem).find('.charger-count').text().trim();

            chargerMap.set(location, {
                count: parseInt(count) || 0,
                providers: providers.join(', '),
                types: types.join(', ')
            });
        });

        // 合併充電站數據到停車場數據
        carparks.forEach(carpark => {
            try {
                const chargerInfo = chargerMap.get(carpark.name);
                if (chargerInfo) {
                    carpark.chargingStations = chargerInfo.count;
                    carpark.chargingProvider = chargerInfo.providers;
                    carpark.chargingType = chargerInfo.types;
                    carpark.hasCharging = true;
                } else {
                    carpark.hasCharging = false;
                }

                // 格式化顯示信息
                carpark.displayInfo = formatDisplayInfo(carpark);
            } catch (error) {
                logger.error('處理充電站數據錯誤', { error: error.message, carpark: carpark.name });
            }
        });

        // 數據清理和排序
        const validCarparks = carparks
            .filter(validateCarpark)
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));

        // 保存到數據庫前的最後驗證
        if (validCarparks.length === 0) {
            throw new Error('沒有有效的停車場數據');
        }

        // 保存到數據庫
        await CarparkModel.create({ 
            data: validCarparks,
            lastUpdated: new Date(),
            totalCount: validCarparks.length
        });
        
        return validCarparks;
    } catch (error) {
        logger.error('數據抓取過程錯誤', { error: error.message, stack: error.stack });
        const lastCache = await CarparkModel.findOne().sort({ lastUpdated: -1 });
        if (lastCache) {
            logger.info('使用緩存數據', { cacheAge: Date.now() - lastCache.lastUpdated });
            return lastCache.data;
        }
        throw error;
    }
}

// 格式化顯示信息的輔助函數
function formatDisplayInfo(carpark) {
    const info = [];
    
    if (carpark.isStreetParking) {
        info.push(`路邊泊車位: ${carpark.capacity}個`);
        if (carpark.streetParking.fee) {
            info.push(`收費: ${carpark.streetParking.fee}`);
        }
    } else {
        info.push(`停車場車位: ${carpark.capacity}個`);
        if (carpark.streetParking.total > 0) {
            info.push(`路邊泊車位: ${carpark.streetParking.total}個`);
            if (carpark.streetParking.fee) {
                info.push(`路邊收費: ${carpark.streetParking.fee}`);
            }
        }
    }

    if (carpark.hasCharging) {
        info.push(`充電站: ${carpark.chargingStations}個`);
    }

    if (carpark.openingHours) {
        info.push(`營業時間: ${carpark.openingHours}`);
    }

    return info.join(' | ');
}

app.post('/api/carparks', async (req, res) => {
    try {
        const { lat, lng } = req.body;
        
        if (!lat || !lng || isNaN(lat) || isNaN(lng)) {
            return res.status(400).json({ error: '無效的經緯度' });
        }

        const carparks = await scrapeCarparks();
        
        // 篩選5公里範圍內的停車場
        const nearbyCarparks = carparks.filter(carpark => {
            try {
                const distance = calculateDistance(
                    parseFloat(lat), 
                    parseFloat(lng), 
                    carpark.latitude, 
                    carpark.longitude
                );
                return distance <= 5;
            } catch (error) {
                console.error('距離計算錯誤：', error);
                return false;
            }
        });

        res.json(nearbyCarparks);
    } catch (error) {
        console.error('API錯誤：', error);
        res.status(500).json({ 
            error: '服務器錯誤',
            message: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// 添加新的 API 端點來獲取附近建築物
app.get('/api/nearby-buildings', async (req, res) => {
    try {
        const { lat, lng } = req.query;
        const response = await axios.get(`https://api.map.gov.hk/nearest/building?lat=${lat}&lng=${lng}&radius=5000`, {
            headers: {
                'Accept': 'application/json'
            }
        });
        
        // 整理建築物數據
        const buildings = response.data.map(building => ({
            name: building.name_tc || building.name,
            type: building.type_tc || building.type,
            distance: building.distance
        })).sort((a, b) => a.distance - b.distance);

        res.json(buildings);
    } catch (error) {
        console.error('Error fetching nearby buildings:', error);
        res.status(500).json({ error: '無法獲取附近建築物數據' });
    }
});

// 修改充電站 API 以包含附近建築物
app.get('/api/chargers', async (req, res) => {
    try {
        const [chargersResponse, buildingsResponse] = await Promise.all([
            axios.get('https://www.kilowatt.hk/api/v1/chargers', {
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            }),
            axios.get('https://api.map.gov.hk/building/list', {
                headers: {
                    'Accept': 'application/json'
                }
            })
        ]);

        const chargers = chargersResponse.data;
        const buildings = buildingsResponse.data;

        // 為每個充電站添加附近建築物信息
        const enrichedChargers = chargers.map(charger => {
            const nearbyBuildings = buildings.filter(building => {
                const distance = calculateDistance(
                    charger.latitude,
                    charger.longitude,
                    building.latitude,
                    building.longitude
                );
                return distance <= 5; // 5公里範圍內
            }).map(building => ({
                name: building.name_tc || building.name,
                type: building.type_tc || building.type,
                distance: calculateDistance(
                    charger.latitude,
                    charger.longitude,
                    building.latitude,
                    building.longitude
                ).toFixed(1)
            })).sort((a, b) => a.distance - b.distance);

            return {
                ...charger,
                nearbyBuildings
            };
        });

        res.json(enrichedChargers);
    } catch (error) {
        console.error('Error fetching data:', error);
        res.status(500).json({ error: '無法獲取數據' });
    }
});

// 錯誤處理中間件
app.use((err, req, res, next) => {
    console.error('未處理的錯誤：', err);
    res.status(500).json({ error: '服務器內部錯誤' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 