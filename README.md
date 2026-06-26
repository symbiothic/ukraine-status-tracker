# 🇺🇦 Статус населених пунктів України

Інтерактивна таблиця окупованих та вільних населених пунктів України на основі даних **[DeepStateMap](https://deepstatemap.live)**.

## 🚀 Як запустити

### 1. Форкніть або клонуйте репозиторій

```bash
git clone https://github.com/YOUR_USERNAME/ukraine-status-tracker.git
cd ukraine-status-tracker
```

### 2. Налаштуйте GitHub Pages

1. Відкрийте **Settings → Pages**
2. Source: `Deploy from a branch`
3. Branch: `main`, folder: `/ (root)`
4. Збережіть — сайт буде доступний за адресою `https://YOUR_USERNAME.github.io/ukraine-status-tracker`

### 3. Дозвольте GitHub Actions запис у репо

1. Відкрийте **Settings → Actions → General**
2. Прокрутіть до "Workflow permissions"
3. Оберіть **"Read and write permissions"**
4. Збережіть

### 4. Перший запуск Actions

Перейдіть до **Actions → Update DeepStateMap Data → Run workflow** — це завантажить перші дані.

Надалі дані оновлюються **автоматично кожні 15 хвилин**.

---

## 📁 Структура проєкту

```
/
├── index.html          # Головна сторінка
├── style.css           # Стилі (темна / світла тема)
├── script.js           # Логіка таблиці (пошук, фільтри, сортування)
├── build_locations.py  # Скрипт для побудови бази населених пунктів
├── data/
│   ├── map.json        # Кеш даних DeepStateMap (оновлюється Actions)
│   ├── meta.json       # Метадані (час оновлення, кількість features)
│   └── locations.json  # База даних: назва → область / район
├── .github/
│   └── workflows/
│       └── update-data.yml  # GitHub Actions workflow
└── README.md
```

---

## ⚙️ Як це працює

```
DeepStateMap API
      ↓
GitHub Actions (кожні 15 хв)
      ↓
data/map.json (у репозиторії)
      ↓
Браузер (index.html + script.js)
      ↓
Таблиця з пошуком, фільтрами, сортуванням
```

**Без бекенду** — тільки статичні файли на GitHub Pages.

---

## 🔍 Можливості

| Функція | Опис |
|---|---|
| 🟢 / 🔴 Статус | Вільний / Окупований / Невідомо |
| 🔍 Пошук | Миттєвий пошук по назві, області, районі |
| 🔽 Фільтри | По області, районі, статусі |
| ↕ Сортування | По кожному стовпцю (А→Я / Я→А) |
| 🗺 Карта | Посилання на конкретну точку на DeepStateMap |
| 🌙 / ☀️ Тема | Темна / світла тема |
| 📱 Адаптивний | Коректне відображення на телефоні |
| ♻️ Автооновлення | Нові дані кожні 15 хвилин (без перезавантаження) |

---

## 📝 Ліцензія

Дані надані [DeepStateMap](https://deepstatemap.live). Код — MIT.
