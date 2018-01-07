{
  'targets': [
    {
      'target_name': 'binding',
      'sources': [ 'binding.cc', 'scrypt.cc', 'scrypt_sse2.cc' ],
      'include_dirs' : [ '<!(node -e "require(\'nan\')")' ]
    }
  ]
}
