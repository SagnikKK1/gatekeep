def call(env)
  if env['PATH_INFO'].start_with?('/a')
    [200, {}, []]
  else
    [404, {}, []]
  end
end
