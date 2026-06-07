let _lastCalendarWriteTime: number = 0;

export const markCalendarWrite = () => {
  _lastCalendarWriteTime = Date.now();
};

export const millisSinceLastWrite = () => {
  return Date.now() - _lastCalendarWriteTime;
};

export const calendarWriteIsRecent = () => {
  return millisSinceLastWrite() < 4000; // 4 second grace window
};
