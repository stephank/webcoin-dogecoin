#include <nan.h>
#include "scrypt.h"

void Scrypt(const Nan::FunctionCallbackInfo<v8::Value> &info) {
  auto buf = Nan::NewBuffer(32).ToLocalChecked();

  auto input = node::Buffer::Data(info[0]);
  auto output = node::Buffer::Data(buf);
  scrypt_1024_1_1_256(input, output);

  info.GetReturnValue().Set(buf);
}


NAN_MODULE_INIT(InitAll) {
  scrypt_detect_sse2();
  Nan::Export(target, "scrypt", Scrypt);
}

NODE_MODULE(binding, InitAll)
