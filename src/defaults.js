/**
 * كل القيم هنا "ديفولت" بس. أي حاجة منها بتتغير من لوحة التحكم > الإعدادات
 * ومحدش بيتعدّل في الكود.
 */
export const DEFAULT_SETTINGS = {
  business: {
    name: 'متجرنا',
    description: '',
    phone: '',
    address: '',
    working_hours_text: '',
    policies: { return: '', exchange: '', warranty: '', delivery: '', other: '' },
  },
  persona: {
    instructions:
      'أنت موظف مبيعات ودود ومحترم في المتجر. هدفك تساعد العميل يلاقي اللي محتاجه، وترد على أسئلته بوضوح، وتاخد أوردره لو حب يطلب. ' +
      'كن مؤدب دايمًا حتى لو العميل متعصب، ولا تجادل. اسأل سؤال واحد أو اتنين في الرسالة الواحدة مش أكتر.',
    style:
      'اتكلم بلهجة مصرية بسيطة ومهذبة. رسائل قصيرة وواضحة. استخدم إيموجي بسيط جدًا لو مناسب. ' +
      'لو العميل كلمك بلغة تانية (إنجليزي مثلًا) رد عليه بنفس لغته.',
    greeting: 'أهلاً بحضرتك في {business_name} 🌷 اتفضل أقدر أساعدك إزاي؟',
    extra_instructions: '',
    forbidden_topics: '',
  },
  bot: {
    enabled: true,
    debounce_ms: 2500,
    history_limit: 30,
    max_tool_rounds: 8,
    human_takeover_minutes: 60,
    typing_indicator: true,
    max_attempts: 3,
    fallback_message: 'معلش حصلت مشكلة بسيطة عندنا. هحوّل حضرتك لحد من الفريق يرد عليك في أقرب وقت 🙏',
  },
  ai: {
    provider: 'auto', // auto | anthropic | mock
    model: 'claude-sonnet-5-5',
    max_tokens: 1024,
    timeout_ms: 45000,
    api_key: '',
    understand_images: true,
  },
  orders: {
    customer_fields: [
      { key: 'name', label: 'الاسم', required: true, hint: 'اسم العميل بالكامل' },
      { key: 'phone', label: 'رقم الموبايل', required: true, hint: 'رقم موبايل للتواصل مع المندوب' },
      { key: 'governorate', label: 'المحافظة', required: true, hint: 'المحافظة لحساب الشحن' },
      { key: 'address', label: 'العنوان', required: true, hint: 'العنوان بالتفصيل (المنطقة، الشارع، رقم العمارة والشقة)' },
    ],
    phone_regex: '^01[0125][0-9]{8}$',
    require_confirmation: true,
    statuses: ['جديد', 'مؤكد', 'تم الشحن', 'تم التسليم', 'ملغي'],
    default_status: 'جديد',
    number_prefix: 'ORD-',
    next_number: 1001,
    decrement_stock: true,
    payment_methods: [{ name: 'كاش عند الاستلام', instructions: '' }],
  },
  shipping: {
    default_price: 60,
    free_over: 0,
    unknown_governorate: 'ask', // ask = يرجع يسأل العميل | default_price = يطبق السعر الافتراضي
  },
  discounts: { max_percent_cap: 30 },
  working_hours: {
    enabled: false,
    start: '10:00',
    end: '22:00',
    timezone: 'Africa/Cairo',
    off_hours_message: 'شكرًا لتواصلك 🌷 إحنا خارج مواعيد العمل حاليًا وهنرد عليك أول ما نبدأ.',
    bot_replies_off_hours: true,
  },
  handoff: {
    keywords: ['مدير', 'شكوى', 'شكوي', 'موظف', 'كلم حد', 'خدمة العملاء', 'manager', 'complaint'],
    message: 'حاضر، هحوّل حضرتك لحد من الفريق يتابع معاك دلوقتي 🙏',
    pause_bot: true,
  },
  learning: {
    mode: 'review', // auto = يحفظ إجاباتك مباشرة | review = يستنى موافقتك | off
  },
  notifications: {
    telegram_bot_token: '',
    telegram_chat_id: '',
    order_webhook_url: '',
    order_webhook_secret: '',
    notify_customer_on_status: false,
    status_messages: {
      'مؤكد': 'تم تأكيد طلبك رقم {number} ✅ هيتجهز ويتشحن في أقرب وقت.',
      'تم الشحن': 'طلبك رقم {number} اتشحن 🚚 المندوب هيتواصل معاك قريب.',
      'تم التسليم': 'شكرًا لتعاملك معانا 🌷 نتمنى الطلب {number} يعجبك!',
      'ملغي': 'تم إلغاء طلبك رقم {number}. لو محتاج أي مساعدة احنا موجودين.',
    },
  },
  channels: {
    public_base_url: '',
    graph_version: 'v21.0',
    verify_code: '',
    app_secret: '',
    messenger: { enabled: false, page_access_token: '' },
    instagram: { enabled: false, access_token: '' },
    whatsapp: { enabled: false, phone_number_id: '', access_token: '' },
  },
  active_mode_id: null,
};

export const DEFAULT_MODES = [
  {
    name: 'عادي (مبيعات مهذبة)',
    description: 'يرد، يرشّح، ياخد الأوردر. بدون عروض خصم من عنده.',
    instructions: 'ساعد العميل بهدوء ولا تضغط عليه. لو سأل عن منتج، رشّح له المناسب وقوله السعر والمتاح.',
    take_orders: true, allow_retention_discount: false, allow_upsell: false, send_images: true,
  },
  {
    name: 'بيع نشط (يقفل الصفقة)',
    description: 'يقترح منتجات مكمّلة، ولو العميل هيمشي يقدر يعرض الخصم المتاح.',
    instructions:
      'حاول تقفل الصفقة بلطف. اقترح منتج مكمّل واحد بس بعد ما العميل يختار. ' +
      'لو العميل قال "هفكر" أو السعر غالي أو هيمشي، وفيه خصم مسموح بيه في الأدوات، اعرضه مرة واحدة بس.',
    take_orders: true, allow_retention_discount: true, allow_upsell: true, send_images: true,
  },
  {
    name: 'خدمة عملاء فقط',
    description: 'يجاوب على الاستفسارات ولا ياخد أوردرات (للإجازات أو لحد ما المخزون يتجدد).',
    instructions: 'جاوب على الأسئلة فقط. لو العميل عايز يطلب، قوله إن الطلبات متوقفة مؤقتًا وهنبلغه أول ما تتفتح.',
    take_orders: false, allow_retention_discount: false, allow_upsell: false, send_images: true,
  },
];

export const DEFAULT_DISCOUNTS = [
  {
    name: 'خصم 10% لإتمام الطلب', type: 'percent', value: 10, trigger: 'retention', max_discount: 0, active: 1,
    instructions: 'يتعرض مرة واحدة بس لو العميل مهتم لكن متردد أو هيمشي. لا يتعرض لو العميل ما اعترضش.',
  },
  {
    name: 'خصم 5% على الطلبات فوق 1500 جنيه', type: 'percent', value: 5, trigger: 'min_order', min_order: 1500, active: 0,
    instructions: 'بيتطبق تلقائيًا لما إجمالي المنتجات يوصل للحد.',
  },
];

// اسم المحافظة + مدة التوصيل (اختياري) + أسماء بديلة للمطابقة
export const DEFAULT_GOVERNORATES = [
  { name: 'القاهرة', aliases: 'cairo,القاهره' },
  { name: 'الجيزة', aliases: 'giza,الجيزه' },
  { name: 'الإسكندرية', aliases: 'اسكندرية,اسكندريه,الاسكندريه,alexandria' },
  { name: 'القليوبية', aliases: 'القليوبيه,qalyubia,بنها,شبرا الخيمة' },
  { name: 'الشرقية', aliases: 'الشرقيه,sharqia,الزقازيق' },
  { name: 'الدقهلية', aliases: 'الدقهليه,dakahlia,المنصورة,المنصوره' },
  { name: 'الغربية', aliases: 'الغربيه,gharbia,طنطا' },
  { name: 'المنوفية', aliases: 'المنوفيه,menoufia,شبين الكوم' },
  { name: 'البحيرة', aliases: 'البحيره,beheira,دمنهور' },
  { name: 'كفر الشيخ', aliases: 'kafr el sheikh' },
  { name: 'دمياط', aliases: 'damietta' },
  { name: 'بورسعيد', aliases: 'port said,بور سعيد' },
  { name: 'الإسماعيلية', aliases: 'الاسماعيلية,الاسماعيليه,ismailia' },
  { name: 'السويس', aliases: 'suez' },
  { name: 'شمال سيناء', aliases: 'north sinai,العريش' },
  { name: 'جنوب سيناء', aliases: 'south sinai,شرم الشيخ,دهب' },
  { name: 'الفيوم', aliases: 'fayoum' },
  { name: 'بني سويف', aliases: 'beni suef' },
  { name: 'المنيا', aliases: 'minya' },
  { name: 'أسيوط', aliases: 'اسيوط,asyut,assiut' },
  { name: 'سوهاج', aliases: 'sohag' },
  { name: 'قنا', aliases: 'qena' },
  { name: 'الأقصر', aliases: 'الاقصر,luxor' },
  { name: 'أسوان', aliases: 'اسوان,aswan' },
  { name: 'البحر الأحمر', aliases: 'red sea,الغردقة,الغردقه,hurghada' },
  { name: 'الوادي الجديد', aliases: 'new valley,الخارجة' },
  { name: 'مطروح', aliases: 'matrouh,مرسى مطروح,marsa matrouh' },
];
