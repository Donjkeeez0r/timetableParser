const cheerio = require('cheerio');
const puppeteer = require('puppeteer');

require('dotenv').config();

const FACULTY_URLS = {
    'ФИСТ': process.env.FIST,
    'ИАТУ': process.env.IATU,
}

const lessonTypes = {
    'лек.': '📖 Лекция',
    'пр.': '🖊  Практика',
    'лаб.': '💻 Лаб.'
};

const times = [
    '08:30 - 09:50',
    '10:00 - 11:20',
    '11:30 - 12:50',
    '13:30 - 14:50',
    '15:00 - 16:20',
    '16:30 - 17:50',
    '18:00 - 19:20',
    '19:30 - 20:50' 
];


const targetGroup = process.argv[2] || 'ИСТбд-32';
const weekIndex = parseInt(process.argv[3]) || 0;
const targetFaculty = process.argv[4] || 'ФИСТ';

// достаем ссылку факультета
const targetUrl = FACULTY_URLS[targetFaculty];

if (!targetUrl) {
    console.log(`Ошибка: Факультет '${targetFaculty}' не найден в списке.`);
    process.exit(1);
}

const getFreshCookies = async () => {

    const browser = await puppeteer.launch({ headless: false });
    const page = await browser.newPage();
    const userAgent = await page.evaluate(() => navigator.userAgent);

    const loginUrl = process.env.LOGIN_URL;
    await page.goto(loginUrl);

    // ввод логина и пароля
    await page.type('#login', process.env.MY_LOGIN);
    await page.type('#password', process.env.MY_PASSWORD);

    
    // нажатие на кнопку войти
    await Promise.all([
        page.click('.btn.btn-primary.btn-block'),
        page.waitForNavigation({ waitUntil: 'networkidle0' }),
    ]);

    //await page.goto('https://lk.ulstu.ru/timetable/');
    await page.goto(process.env.TIMETABLE_URL);
    await page.goto(targetUrl);

    // забираем куки из браузера
    const cookiesArray = await page.cookies();
    
    // превращаем массив объектов в массив строк вида 'name=value'
    const cookieHeader = cookiesArray.map(c => `${c.name}=${c.value}`).join('; ');

    await browser.close();

    return { 
        cookies: cookieHeader,
        userAgent: userAgent
    };
}


const fetchWithAuth = async (url, cookies, userAgent) => {
    // запрос с нашими заголовками
    const response = await fetch(url, {
        headers: {
            'Cookie': cookies,
            'User-Agent': userAgent
        }
    });

    if (!response.ok) {
        throw new Error(`Ошибка при загрузке ${url}: ${response.status}`);
    }

    // возвращаем текст страницы
    return await response.text();
}

const findMyShedule = async (cookies, userAgent) => {
    // загружаем главную страницу
    const mainHtml = await fetchWithAuth(targetUrl, cookies, userAgent);
    
    // загружаем страемцу в cheerio
    const $main = cheerio.load(mainHtml);

    // находим все теги <a> 
    const groupLink = $main('a').filter((i, el) => {
        // i - номер ссылки
        // el - сам тег <a>

        // получаем текст внутри текущей ссылки
        const text = $main(el).text().trim();

        // оставляем ссылку с нашей группой
        return text.includes(targetGroup);
    });
    
    // достаем путь ссылки href (например - /timetable/group/123)
    const relativePath = groupLink.attr('href');

    // берем базовую ссылку (https://...ru/timetable/.../)
    const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

    // полная ссылка на группу
    const fullUrl = baseUrl + relativePath;
    
    // получаем html расписание конкретной группы
    const groupHtml = await fetchWithAuth(fullUrl, cookies, userAgent);
    
    // загружаем html группы для парсинга
    const $group = cheerio.load(groupHtml);

    // находим все таблицы на странице расписания
    const tables = $group('table');

    // берем таблицу по индексу (недели)
    const selectedTable = tables.eq(weekIndex);

    if (selectedTable.length === 0) {
        console.log(`⚠️ Таблица для недели №${weekIndex + 1} не найдена на странице.`);
        return;
    }
    
    // итоговое расписание
    let resultMessage = '';

    // находим все строки таблицы (<tr>)
    const rows = selectedTable.find('tr');

    // пропускаем первые две строки (заголовки таблиц) и перебираем остальные
    // каждая строка - день недели
    rows.slice(2).each((i, row) => {
        
        // находим все ячейки в строке
        const cells = $group(row).find('td');

        // первая ячейка - это дата, берем текст и обрезаем пробелы
        const dayInfo = $group(cells[0]).text().trim();

        // массив для пар за день
        let allLessonsForDay = [];

        // перебираем остальные ячейки - пары
        cells.slice(1).each((j, cell) => {
            // внцтри ячейки ищем <font> и берем html
            let htmlContent = $group(cell).find('font').html();
            
            if (!htmlContent) htmlContent = $group(cell).html();

            // разбиваем по <br> - каждый перенос, это отдельная информация о паре
            let parts = htmlContent.split('<br>')
                .map(p => {
                    // Оборачиваем строку в cheerio и забираем только текст
                    return cheerio.load(p).text().trim();
                })
                .filter(p => p.length > 0);
            
            let currentPair = [];
            // перебираем все части текста внутри ячейки
            parts.forEach(part => {
                const isType = part.includes('лаб.') || part.includes('пр.') || part.includes('лек.');
                
                // если нашли тип пары, то это новая пара
                if (isType && currentPair.length > 0) {
                    allLessonsForDay.push({
                        number: j + 1,
                        data: currentPair
                    });
                    currentPair = []
                }
                currentPair.push(part);
            });

            // если после перебора всех частей что-то осталось, то добавляем последнюю пару в массив дня
            if (currentPair.length > 0) {
                allLessonsForDay.push({
                    number: j + 1,
                    data: currentPair
                });
            } 
        });

        // формирование текста для пар
        if (allLessonsForDay.length > 0) {
            resultMessage += `📅 *${dayInfo}*\n`;

            allLessonsForDay.forEach(lesson => {
                const typeKey = lesson.data[0];
                const name = lesson.data[1];
                const room = lesson.data[2];

                const typePretty = lessonTypes[typeKey] || typeKey;
                const time = times[lesson.number - 1];
                const lessonString = `${lesson.number}-я пара (${time}): ${typePretty} ${name}, ${room}\n`;

                resultMessage += lessonString;
            });
            resultMessage += '\n';
        }
    });

    return resultMessage;
}

let currentCookies = '';
let currentAgent = '';

const start = async () => {
    const maxAttempts = 3;
    let success = false;
    let finalShedule = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // если куки пустые
        if (!currentCookies) {
            const authData = await getFreshCookies();
            currentCookies = authData.cookies;
            currentAgent = authData.userAgent;
        }

        try {
            finalShedule = await findMyShedule(currentCookies, currentAgent);
            success = true;
            break; 
        } catch (error) {
            if (error.message.includes('401') || error.message.includes('403')) {           
                // очистка куки, чтобы снова запустить браузер
                currentCookies = '';
            } else {
                console.log('Произошла непредвиденная ошибка:', error.message);
                break;
            }
        }
    }
    if (success) {
        return finalShedule;
    } else {
        throw new Error('Не удалось получить расписание после всех попыток.');
    }
}

start().then(res => console.log(res)).catch(err => console.error('Ошибка в работе программы:', err.message));