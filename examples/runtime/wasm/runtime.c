#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>

#define MAX_MESSAGE (1024 * 1024)

static char input[MAX_MESSAGE + 8];
static char output[MAX_MESSAGE + 8];
static size_t output_length;

static void append(const char *value) {
  size_t length = strlen(value);
  if (output_length + length > MAX_MESSAGE) _exit(2);
  memcpy(output + output_length, value, length);
  output_length += length;
}

static void append_number(unsigned value) {
  char digits[16];
  size_t length = 0;
  do {
    digits[length++] = (char)('0' + value % 10);
    value /= 10;
  } while (value != 0);
  while (length != 0) {
    char character[2] = {digits[--length], 0};
    append(character);
  }
}

static int field_string_from(const char *source, const char *name, char *target, size_t maximum) {
  char needle[96];
  size_t name_length = strlen(name);
  if (name_length + 5 >= sizeof needle) return 0;
  needle[0] = '"';
  memcpy(needle + 1, name, name_length);
  memcpy(needle + 1 + name_length, "\":\"", 4);
  const char *start = strstr(source, needle);
  if (start == NULL) return 0;
  start += name_length + 4;
  const char *end = start;
  while (*end != 0 && *end != '"') {
    if (*end == '\\') return 0;
    end++;
  }
  size_t length = (size_t)(end - start);
  if (*end != '"' || length + 1 > maximum) return 0;
  memcpy(target, start, length);
  target[length] = 0;
  return 1;
}

static unsigned field_number(const char *source, const char *name) {
  char needle[96];
  size_t name_length = strlen(name);
  needle[0] = '"';
  memcpy(needle + 1, name, name_length);
  memcpy(needle + 1 + name_length, "\":", 3);
  const char *start = strstr(source, needle);
  if (start == NULL) return 0;
  start += name_length + 3;
  unsigned value = 0;
  while (*start >= '0' && *start <= '9') value = value * 10 + (unsigned)(*start++ - '0');
  return value;
}

static void state(const char *source, unsigned *generation, unsigned *calls, unsigned *pending,
                  char *first, size_t first_size) {
  char encoded[2048];
  if (!field_string_from(source, "continuation", encoded, sizeof encoded)) {
    *generation = 0;
    *calls = 0;
    *pending = 0;
    first[0] = 0;
    return;
  }
  const char *cursor = encoded;
  if (*cursor++ != 'g') _exit(2);
  *generation = 0;
  while (*cursor >= '0' && *cursor <= '9') *generation = *generation * 10 + (unsigned)(*cursor++ - '0');
  if (*cursor++ != 'c') _exit(2);
  *calls = 0;
  while (*cursor >= '0' && *cursor <= '9') *calls = *calls * 10 + (unsigned)(*cursor++ - '0');
  if (*cursor++ != 'p') _exit(2);
  *pending = 0;
  while (*cursor >= '0' && *cursor <= '9') *pending = *pending * 10 + (unsigned)(*cursor++ - '0');
  if (*cursor++ != 'f') _exit(2);
  size_t length = strlen(cursor);
  if (length + 1 > first_size) _exit(2);
  memcpy(first, cursor, length + 1);
}

static void continuation(unsigned generation, unsigned calls, unsigned pending, const char *first) {
  append(",\"continuation\":\"g");
  append_number(generation);
  append("c");
  append_number(calls);
  append("p");
  append_number(pending);
  append("f");
  append(first);
  append("\"}");
}

static void prefix(const char *type, const char *id) {
  output_length = 0;
  append("{\"protocol\":\"polici.runtime/v1\",\"type\":\"");
  append(type);
  append("\",\"id\":\"");
  append(id);
}

static void capability(const char *id, unsigned generation, unsigned calls, unsigned sequence,
                       const char *first) {
  prefix("capability-call", id);
  append("\",\"requestId\":\"");
  append(id);
  append("-capability-");
  append_number(sequence);
  append("\",\"sequence\":");
  append_number(sequence);
  append(",\"capability\":\"example:data\",\"operation\":\"read\",\"arguments\":");
  if (sequence == 2) append("{\"page\":{\"tag\":\"integer\",\"value\":\"2\"}}");
  else append("{}");
  continuation(generation, calls, sequence, first);
}

static void result_string(const char *id, const char *value, unsigned generation, unsigned calls) {
  prefix("result", id);
  append("\",\"value\":{\"tag\":\"string\",\"value\":\"");
  append(value);
  append("\"}");
  continuation(generation, calls, 0, "-");
}

static void handle(const char *message) {
  char type[64], id[128], resolver[128];
  if (!field_string_from(message, "type", type, sizeof type) ||
      !field_string_from(message, "id", id, sizeof id)) _exit(2);

  if (strcmp(type, "initialize") == 0) {
    const char *plugin = strstr(message, "\"plugin\":{");
    char name[128], version[128];
    if (plugin == NULL || !field_string_from(plugin, "name", name, sizeof name) ||
        !field_string_from(plugin, "version", version, sizeof version)) _exit(2);
    prefix("initialized", id);
    append("\",\"implementation\":{\"name\":\"");
    append(name);
    append("\",\"version\":\"");
    append(version);
    append("\"},\"capabilities\":[\"example:data\"]");
    continuation(1, 0, 0, "-");
    return;
  }

  unsigned generation, calls, pending;
  char first[1024];
  state(message, &generation, &calls, &pending, first, sizeof first);
  generation++;

  if (strcmp(type, "shutdown") == 0) {
    prefix("stopped", id);
    append("\"}");
    return;
  }

  if (strcmp(type, "call") == 0) {
    if (!field_string_from(message, "resolver", resolver, sizeof resolver)) _exit(2);
    calls++;
    if (strcmp(resolver, "success") == 0) {
      result_string(id, "ok", generation, calls);
      return;
    }
    if (strcmp(resolver, "missing") == 0) {
      prefix("result", id);
      append("\",\"value\":{\"tag\":\"missing\"}");
      continuation(generation, calls, 0, "-");
      return;
    }
    if (strcmp(resolver, "multiple") == 0) {
      capability(id, generation, calls, 1, "-");
      return;
    }
    if (strcmp(resolver, "lifecycle") == 0) {
      prefix("result", id);
      append("\",\"value\":{\"tag\":\"map\",\"entries\":{\"initialized\":{\"tag\":\"integer\",\"value\":\"1\"},\"calls\":{\"tag\":\"integer\",\"value\":\"");
      append_number(calls);
      append("\"}}}");
      continuation(generation, calls, 0, "-");
      return;
    }
    prefix("error", id);
    append("\",\"error\":{\"code\":\"RESOLVER_NOT_FOUND\",\"kind\":\"resolver\",\"message\":\"Unknown resolver\",\"retryable\":false}");
    continuation(generation, calls, 0, "-");
    return;
  }

  if (strcmp(type, "capability-result") == 0) {
    char value[1024];
    const char *result = strstr(message, "\"result\":{");
    if (result == NULL || !field_string_from(result, "value", value, sizeof value)) _exit(2);
    unsigned sequence = field_number(message, "sequence");
    if (pending == 1 && sequence == 1) {
      capability(id, generation, calls, 2, value);
      return;
    }
    if (pending == 2 && sequence == 2) {
      prefix("result", id);
      append("\",\"value\":{\"tag\":\"list\",\"items\":[{\"tag\":\"string\",\"value\":\"");
      append(first);
      append("\"},{\"tag\":\"string\",\"value\":\"");
      append(value);
      append("\"}]}");
      continuation(generation, calls, 0, "-");
      return;
    }
  }
  _exit(2);
}

int main(void) {
  size_t length = 0;
  while (length < MAX_MESSAGE + 4) {
    ssize_t count = read(0, input + length, MAX_MESSAGE + 4 - length);
    if (count < 0) return 2;
    if (count == 0) break;
    length += (size_t)count;
  }
  if (length == 0 || length > MAX_MESSAGE + 4) return 2;
  int framed = input[0] != '{';
  const char *message = input;
  size_t message_length = length;
  if (framed) {
    if (length < 4) return 2;
    message_length = ((unsigned char)input[0] << 24) | ((unsigned char)input[1] << 16) |
                     ((unsigned char)input[2] << 8) | (unsigned char)input[3];
    if (message_length + 4 != length) return 2;
    message = input + 4;
  } else if (input[length - 1] == '\n') {
    message_length--;
  }
  input[(size_t)(message - input) + message_length] = 0;
  handle(message);
  if (framed) {
    unsigned char header[4] = {(unsigned char)(output_length >> 24),
                               (unsigned char)(output_length >> 16),
                               (unsigned char)(output_length >> 8), (unsigned char)output_length};
    if (write(1, header, 4) != 4) return 2;
  }
  if (write(1, output, output_length) != (ssize_t)output_length) return 2;
  if (!framed && write(1, "\n", 1) != 1) return 2;
  return 0;
}
