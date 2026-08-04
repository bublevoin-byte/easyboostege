const tasks = Object.freeze({
  'builtin:speaking:task:2:v1': Object.freeze({
    taskNumber: 2,
    assignment: Object.freeze({
      ad: 'Language Summer Camp «Sunny Hills». English every day with native speakers, sports and new friends! Join us this summer!',
      points: Object.freeze(['dates of the course', 'price', 'number of lessons a day', 'accommodation']),
    }),
  }),
  'builtin:speaking:task:4:v1': Object.freeze({
    taskNumber: 4,
    assignment: Object.freeze({
      topic: 'Зимние каникулы',
      plan: Object.freeze([
        'кратко опиши обе фотографии — что на них происходит',
        'скажи, что общего у этих фотографий',
        'скажи, чем они различаются',
        'скажи, какой отдых ближе тебе, и объясни почему',
      ]),
      ph: Object.freeze([
        'Фото 1: семья катается на лыжах в горах в солнечный день',
        'Фото 2: девушка читает книгу у камина дома',
      ]),
    }),
  }),
});

export function adaptiveSpeakingTask(contentRef) {
  const task = tasks[String(contentRef || '')];
  return task ? structuredClone(task) : null;
}

export function adaptiveSpeakingContentRef(taskNumber) {
  return Object.keys(tasks).find((ref) => tasks[ref].taskNumber === Number(taskNumber)) || null;
}
